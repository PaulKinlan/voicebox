// browser/worker.ts — THE HOST.
//
// The host owns the tier table, the audit, the projects and the tool run. The page is a renderer
// and this is where authority lives, because §1.1b's rule is that authority is co-located with the
// data it governs — and in this placement the data is the origin's OPFS *or* a folder the user
// picked (N20). Both are roots; neither is a mode.
//
// Five things this file is careful about, each because it is the difference between a mechanism
// and a description:
//
//   1. NOTHING TRUSTS THE TOOL. The module is instantiated with exactly two imports
//      (`writeFile`, `note`) and `writeFile` re-resolves the path it is handed and refuses
//      anything that is not the exact path the host already decided on.
//   2. THE IMPORT IS THE REQUEST. Wasm imports are synchronous and storage is not, so `writeFile`
//      records what the module asked for; the host performs it after `run()` returns, then
//      observes the result FROM THE WORLD and writes the audit entry from that observation.
//   3. CONTAINMENT IS ONE IMPLEMENTATION FOR BOTH ROOT KINDS. A picked folder has no path this
//      origin may describe, so it gets a VIRTUAL root string and the storage adapter strips it.
//      `core/paths.ts` refuses `..` at any depth either way, and the refusal names its rule.
//   4. FAILURES HAVE NAMES. Permission denied, a handle that is gone, and a root that cannot be
//      reached are three different facts with three different recoveries; a generic "internal
//      error" would hide which one the user is in.
//   5. A BAD TURN NEVER KILLS THE HOST. Every message is wrapped; a trap, a malformed body and an
//      unknown kind each produce an error and an audit entry, and the next message is served.

import { resolveInsideRoot } from "../core/paths.ts";
import { decide } from "../core/policy.ts";
import {
  M0_INSTANCE,
  auditFileName,
  makeEntry,
  mergeAudit,
  nextSeq,
  parseEntry,
  resumeSeq,
  serializeEntry,
  type AuditEntry,
} from "../core/audit.ts";
import { makeProjectRecord, type ProjectRecord } from "../core/project.ts";
import { ROOT_FACTS, descriptorOf, describeRoot, reachableFrom } from "../core/root.ts";
import {
  LIVENESS,
  activityEntry,
  land,
  marksToClaim,
  presenceEntry,
  seeEntry,
  type Actor,
  type LogEntryBase,
  type PresenceState,
} from "../core/shared-log.ts";
import { validate, type ToolSchema } from "../core/schema.ts";
import * as idb from "./idb.ts";
import { handleStorage, opfsStorage, type Entry, type Storage } from "./storage.ts";

/**
 * WHO THIS AGENT IS. One worker is one agent instance — §9's actor model in one line: an agent is a
 * named instance, not a directory, so two agents working in one project are two people and their
 * entries are two files a reader merges. The default keeps M0's single agent working unchanged;
 * `identify` names a second one, which is how the two-agent checks drive it.
 */
let instance = M0_INSTANCE;
let actor: Actor = { name: M0_INSTANCE, harness: null, session: null, cwd: null };
const ASSET_DIR = "assets";
const AUDIT_DIR = ".audit";
const UNDO_FILE = ".undo.json";
const REGISTRY_DIR = "v1/registry";
const SCHEMA_URL = "/tools/create-asset.schema.json";
const LIST_LIMIT = 200;
const SERVER_FILES_URL = "/api/files";

/** The tool modules this placement admits, plus two fixtures the acceptance checks instantiate. */
const MODULES: Record<string, string> = {
  "create-asset": "/tools/create-asset.wasm",
  "fixture-fetch-import": "/tests/fixtures/fetch-import.wasm",
  "fixture-trap": "/tests/fixtures/trap.wasm",
};

/**
 * The named failures. Three of them are about a ROOT's reachability and are deliberately not
 * folded into one code: "you must click to restore access", "this project's folder handle is not
 * here", and "the folder is gone or unmounted" are three different things to tell a person.
 */
export type FailureCode =
  | "needs-gesture"
  | "permission-denied"
  | "handle-gone"
  | "root-unreachable"
  | "not-found"
  | "no-project"
  | "not-a-project"
  | "bad-request";

type Failure = { ok: false; code: FailureCode; why: string; detail?: string };

const fail = (code: FailureCode, why: string, detail?: string): Failure => ({ ok: false, code, why, detail });

let wasmInstance: WebAssembly.Instance | null = null;
let schema: ToolSchema | null = null;
let current: ProjectRecord | null = null;
let storage: Storage | null = null;
// Where this root's log actually is. A folder the page may read but not write cannot hold its own
// audit file, and an act that cannot be recorded is not an act this host performs — so the log
// goes to origin-private storage and the RECORD says so, rather than the host pretending or
// silently dropping entries.
let auditFallback = false;
const records = new Map<string, ProjectRecord>();
const pending = new Map<string, { act: { kind: "delete"; target: string; tool: string }; rule: string; why: string }>();

// The host counts what it was asked to do, so "a listing is one message and does not read every
// file" is a number a check can assert rather than a claim in a comment.
const stats = { messages: 0, listings: 0, reads: 0 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------- roots

export function virtualRoot(record: ProjectRecord): string {
  // The string every containment check measures against. For a picked folder it is deliberately
  // not a path: nothing outside this origin can interpret it (§2.1), which is the truth about a
  // handle, and the storage adapter strips it before touching the user's files.
  return record.root.kind === "opfs" ? record.root.path : `picked:${record.name}`;
}

async function storageFor(record: ProjectRecord): Promise<Storage | Failure> {
  if (record.root.kind === "opfs") return await opfsStorage(record.root.path);

  const handle = await idb.getHandle(record.name).catch(() => null);
  if (!handle) {
    return fail(
      "handle-gone",
      `'${record.name}' is a picked folder, and this browser no longer holds its handle — it was picked in another profile, or the record outlived the handle`,
    );
  }
  return handleStorage(handle, virtualRoot(record));
}

/** Query the permission state of a picked root. OPFS is implicit and has no such state. */
async function permission(
  record: ProjectRecord,
  mode: "read" | "readwrite" = "readwrite",
): Promise<"granted" | "prompt" | "denied" | "implicit"> {
  if (record.root.kind === "opfs") return "implicit";
  const handle = await idb.getHandle(record.name).catch(() => null);
  if (!handle) return "denied";
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "denied";
  }
}

/**
 * THE ROOT SEAM, page side: declare a root on the machine's filesystem as this project's root.
 *
 * The page cannot act on a machine root — it has no handle and no path of its own — so the point of
 * declaring one is that the LOOP (a machine process, reached over the same origin) writes into THIS
 * project's root instead of a folder of its own invention. That is the difference between one root
 * and two, and it is why the declaration goes to the server rather than staying in the page.
 */
async function useMachineRoot(message: Record<string, unknown>): Promise<unknown> {
  const requested = String(message.path ?? "").trim();
  const name = String(message.name ?? "").trim() || "project";
  if (!requested) return fail("bad-request", "a machine root needs a path — the folder the loop should write into");

  const response = await fetch("/api/root", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: name, root: { kind: "machine", path: requested } }),
  });
  const declared = (await response.json()) as Record<string, any>;
  if (!declared.ok) {
    // The server's own named refusals (path-missing, not-a-directory) travel unchanged: they are the
    // same facts a person needs, and re-wording them here would be a second vocabulary for one thing.
    return fail((declared.refused as FailureCode) ?? "root-unreachable", String(declared.why ?? "the declaration was refused"), `HTTP ${response.status}`);
  }

  const canonical = String(declared.root.path);
  const record: ProjectRecord = {
    ...(records.get(name) ?? makeProjectRecord(name, "browser")),
    id: `${name}@browser`,
    name,
    placement: "browser",
    location: { kind: "machine", path: canonical },
    root: { kind: "machine", path: canonical },
    capabilities: ["read", "write", "wasm"],
    undoKind: "written-file-list",
    lastUsed: new Date().toISOString(),
    durability: { kind: "machine", path: canonical, checkedAt: new Date().toISOString() },
  };
  current = record;
  storage = null; // this placement has no adapter for a folder it cannot name; acts are refused by name
  await saveRegistry(record);
  await resumeFromEveryRoot();

  return {
    ok: true as const,
    project: { ...record, root: canonical, rootKind: "machine", auditLocation: `${canonical}/.audit/` },
    root: { kind: "machine", path: canonical },
    facts: ROOT_FACTS.machine,
    description: describeRoot({ kind: "machine", path: canonical }),
    // The honest half: declaring it does not give this placement the ability to write there.
    reachableFromThisProcess: false,
    refusalForLocalActs: reachableFrom({ kind: "machine", path: canonical }, "page"),
    canonical: Boolean(declared.canonical),
  };
}

/**
 * The preconditions a write has before the tier table is even consulted, reported BY NAME.
 *
 * A write on a `prompt` handle does not fail — it waits for a prompt that no script can answer
 * (measured, docs/evidence/picked-root-20260919/). So the host refuses in words instead of
 * hanging, and the page offers the one thing that can change the state: a click.
 */
async function writable(name: string): Promise<Failure | null> {
  const record = requireCurrent();
  // (root reachability is checked before this, by `pageReachable`)
  const state = await permission(record);
  if (state === "implicit" || state === "granted") return null;
  const label = record.location.kind === "handle" ? record.location.label : record.name;
  if (state === "prompt") {
    return fail(
      "needs-gesture",
      `'${label}' needs a click before it can be written to: the browser reports 'prompt', and OPFS needs no such thing — that difference is why this is a state and not an error`,
    );
  }
  return fail("permission-denied", `access to '${label}' was declined (queryPermission says 'denied')`);
}

/** Touch the root and let the platform's own error through, because it names the real problem. */
async function reachable(): Promise<Failure | null> {
  const record = requireCurrent();
  // Defence in depth: a root this placement cannot act on is refused before anything else is asked,
  // so nothing downstream can meet a null storage adapter and report it as a missing folder.
  const unreachableHere = pageReachable();
  if (unreachableHere) return unreachableHere;
  // The permission is QUERIED, never assumed: reading a folder whose permission has regressed to
  // `prompt` does not fail, it waits for a dialog no script can answer (measured). So this refuses
  // in words first — and the page can then offer the one thing that changes the state, a click.
  if (record.root.kind === "handle") {
    const read = await permission(record, "read");
    if (read !== "granted") {
      const label = record.location.kind === "handle" ? record.location.label : record.name;
      return read === "denied"
        ? fail("permission-denied", `read access to '${label}' was declined (queryPermission says 'denied')`)
        : fail("needs-gesture", `'${label}' needs a click to restore access: queryPermission says 'prompt', and OPFS needs no such thing`);
    }
  }
  try {
    await storage!.probe();
    return null;
  } catch (e) {
    const error = e as Error;
    return fail(
      "root-unreachable",
      `'${record.name}' cannot be reached: the folder is gone, renamed, or on a volume that is not mounted`,
      `${error?.name}: ${error?.message}`,
    );
  }
}

// ---------------------------------------------------------------- the audit

function root(): string {
  const project = current;
  if (!project) throw new Error("no project is open");
  // The log's name for the boundary. A machine root is labelled by the machine that owns it, because
  // this placement has no storage adapter for it — and a label that pretended to be a local path
  // would make two placements' entries look like one writer's.
  return project.root.kind === "machine" ? `machine:${project.root.path}` : storage!.root;
}

/**
 * THE FIRST QUESTION EVERY ACT ASKS: can this placement act on this root at all?
 *
 * It comes before the tier table, the schema and the containment check, because none of those is
 * interesting if the answer is no — and the refusal must name WHO can, not merely that this side
 * cannot. For a machine root that is the loop; for this placement's own roots it is the page.
 */
function pageReachable(): Failure | null {
  const project = current;
  if (!project) return fail("no-project", "no project is open, so there is no root to act on");
  if (storage) return null;
  const reach = reachableFrom(descriptorOf(project), "page");
  return reach.ok ? null : fail((reach.refused as FailureCode) ?? "root-unreachable", reach.why);
}

/** Host-owned path, never tool input, so it is built rather than resolved. */
function auditPath(): string {
  return `${root()}/${AUDIT_DIR}/${auditFileName(instance, root())}`;
}

async function fallbackAuditPath(): Promise<string> {
  return `v1/audit-fallback/${auditFileName(instance, root())}`;
}

/** This instance's own file — what its sequence resumes from. */
async function readAudit(): Promise<AuditEntry[]> {
  // A root we may read but not write has no audit file of its own (the fallback carries it), and
  // asking for a directory that will never exist there is one of the calls that BLOCKS on a `prompt`
  // handle rather than failing — so the flag decides before we knock.
  const lines = auditFallback ? [] : await storage!.readLines(auditPath());
  const fallback = auditFallback ? await (await opfsStorage("v1/audit-fallback")).readLines(await fallbackAuditPath()) : [];
  return [...lines, ...fallback].map(parseEntry).filter((e): e is AuditEntry => e !== null);
}

/**
 * EVERY WRITER'S FILE FOR ONE ROOT — the shared read, and the reason "one file per root" was always
 * shorthand for "one file per (root, writer)": the design serialises one writer per root, so a file
 * per writer needs no lock, and a reader merges them by `(instance, seq)`.
 *
 * A root this instance may read but not write keeps its log in origin storage (the auditLocation
 * fact), and asking a `prompt` handle for a folder that will never exist there is one of the calls
 * that BLOCKS rather than failing — so the permission decides before we knock.
 */
async function logFilesFor(project: ProjectRecord): Promise<{ name: string; root: string; entries: AuditEntry[]; unreachable?: string }[]> {
  const boundary = virtualRoot(project);
  const files: { name: string; root: string; entries: AuditEntry[]; unreachable?: string }[] = [];

  const store = await storageFor(project);
  if ("ok" in store && store.ok === false) {
    return [{ name: auditFileName(instance, boundary), root: boundary, entries: [], unreachable: (store as Failure).code }];
  }
  const readable = project.root.kind === "opfs" || (await permission(project, "read")) === "granted";
  if (readable) {
    const listing = await (store as Storage).listChildren(`${boundary}/${AUDIT_DIR}`, 500).catch(() => ({ entries: [] }));
    for (const file of listing.entries) {
      if (file.kind !== "file" || !file.name.endsWith(".jsonl")) continue;
      const lines = await (store as Storage).readLines(`${boundary}/${AUDIT_DIR}/${file.name}`);
      files.push({ name: file.name, root: boundary, entries: lines.map(parseEntry).filter((e): e is AuditEntry => e !== null) });
    }
  }

  // The origin-side fallback is keyed by root hash, so a file is only this root's if its entries say
  // so — which is why each entry's own `root` is checked rather than trusting a file name.
  const fallback = await opfsStorage("v1/audit-fallback");
  const fallbackNames = (await fallback.listChildren("v1/audit-fallback", 500).catch(() => ({ entries: [] }))).entries.map((e) => e.name);
  for (const name of fallbackNames) {
    if (!name.endsWith(".jsonl")) continue;
    const lines = await fallback.readLines(`v1/audit-fallback/${name}`);
    const entries = lines.map(parseEntry).filter((e): e is AuditEntry => e !== null && e.root === boundary);
    if (entries.length) files.push({ name: `${name} (origin-side)`, root: boundary, entries });
  }

  return files;
}

/** The shared read for the open project: every writer's entries, merged by `(instance, seq)`. */
async function readLog(): Promise<AuditEntry[]> {
  const project = requireCurrent();
  if (project.root.kind === "machine") {
    // The root's log belongs to the root, and this placement cannot read it from the filesystem — so
    // it asks the placement that can. One log, one answer, whoever is asking.
    const body = (await (await fetch("/api/audit")).json()) as { entries?: AuditEntry[] };
    return body.entries ?? [];
  }
  const files = await logFilesFor(project);
  return files.flatMap((f) => f.entries);
}

/** Append a shared fact. Shared facts go in the same log as the acts — one medium, not two. */
async function appendShared(build: (base: Omit<LogEntryBase, "kind">) => LogEntryBase): Promise<LogEntryBase> {
  const project = requireCurrent();
  const entry = build({
    seq: nextSeq(),
    instance,
    actor,
    project: project.id,
    root: root(),
    turn: null,
    at: new Date().toISOString(),
  });
  await appendAudit(entry as AuditEntry);
  return entry;
}

/**
 * A LOOK: read the log, answer "who is here, what are they doing, what have they read", and claim
 * the positions it folded — appended, never overwritten, so two machines racing converge.
 *
 * Marking on read is the seam: the log can answer "what did it know?" only if readers leave marks,
 * and a mark that is not appended is knowledge nobody can ask about later.
 */
async function look(mark: boolean): Promise<Record<string, unknown>> {
  // A look is a READ of the log, which for a machine root comes from the machine — so this is one of
  // the few acts that works on every root kind, and `readLog` decides where to ask.
  const entries = await readLog();
  const now = new Date();

  // THE VIEW IS COMPUTED BEFORE THE CLAIM, and that ordering is the difference between an answer
  // and nothing at all: claiming first would fold this look's own marks into `unseen` and report an
  // empty backlog every single time — "what you just caught up on" would be invisible, which is
  // exactly the work the reader was looking for.
  const view = land(entries, instance, now);

  const claimed: { of: string; upto: number }[] = [];
  if (mark) {
    for (const position of marksToClaim(entries, instance)) {
      await appendShared((base) => seeEntry(base, position.of, position.upto));
      claimed.push(position);
    }
  }
  return {
    ok: true as const,
    ...view,
    // Serialisable forms for the wire: a Map does not survive a structured clone as a Map a page can
    // compare, so the shape sent is the shape rendered.
    knew: view.knew.map((k) => ({ instance: k.instance, mark: k.mark === null ? null : Object.fromEntries(k.mark) })),
    unseen: view.unseen === null ? null : view.unseen.map((g) => ({ writer: g.writer, entries: g.entries })),
    claimed,
    liveness: LIVENESS,
  };
}

/**
 * Append to the root's own log, or — when the root cannot hold it — to origin-private storage,
 * and remember that fact so the record and the page can state it. A silent fallback would be the
 * "weaker guard" shape: the log would exist, be incomplete, and look complete.
 */
async function appendAudit(entry: AuditEntry): Promise<void> {
  const line = serializeEntry(entry);
  if (!auditFallback) {
    try {
      await storage!.appendLine(auditPath(), line);
      return;
    } catch {
      auditFallback = true;
    }
  }
  const fallback = await opfsStorage("v1/audit-fallback");
  await fallback.appendLine(await fallbackAuditPath(), line);
}

async function record(
  act: { kind: string; target: string; tool?: string },
  decision: AuditEntry["decision"],
  rule: string | null,
  result: AuditEntry["result"],
  observed: AuditEntry["observed"],
  turn: string | null = null,
  read?: { path: string; bytes: number }[],
): Promise<AuditEntry> {
  const project = requireCurrent();
  const entry = makeEntry(project.id, root(), instance, actor, act, decision, rule, result, observed, turn, read);
  await appendAudit(entry);
  return entry;
}

// ---------------------------------------------------------------- projects

async function loadRegistry(): Promise<Map<string, ProjectRecord>> {
  const origin = await opfsStorage(REGISTRY_DIR);
  const { entries } = await origin.listChildren(`${REGISTRY_DIR}`, 500);
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await origin.readText(`${REGISTRY_DIR}/${entry.name}`)) as ProjectRecord;
      records.set(record.name, record);
    } catch {
      // A registry entry that cannot be parsed is not a project; it is also not worth taking the
      // host down for.
    }
  }
  return records;
}

/**
 * Continue this instance's sequence from every root it owns.
 *
 * `seq` is PER-INSTANCE (§4), not per-root: the audit is one file per root so that one writer per
 * root needs no lock, but the numbering a reader merges on belongs to the instance. Resuming from
 * a single root would restart at 1 in the next root, and the merged read would then have two
 * entries numbered 1 — an ambiguous order in exactly the place the log is supposed to answer
 * "what happened, in what order".
 */
async function resumeFromEveryRoot(): Promise<void> {
  const all: AuditEntry[] = [];
  for (const record of records.values()) {
    try {
      const store = await storageFor(record);
      if ("ok" in store && store.ok === false) continue;
      const lines = await (store as Storage).readLines(
        `${virtualRoot(record)}/${AUDIT_DIR}/${auditFileName(instance, virtualRoot(record))}`,
      );
      all.push(...lines.map(parseEntry).filter((e): e is AuditEntry => e !== null));
    } catch {
      // A root that cannot be read contributes nothing to the sequence, and is reported where it
      // matters: on the act that tries to use it.
    }
  }
  resumeSeq(all, instance);
}

async function saveRegistry(record: ProjectRecord): Promise<void> {
  const origin = await opfsStorage(REGISTRY_DIR);
  await origin.writeText(`${REGISTRY_DIR}/${record.name}.json`, JSON.stringify(record, null, 2));
  records.set(record.name, record);
}

async function openProject(name: string): Promise<Record<string, unknown> | Failure> {
  const clean = String(name ?? "").trim();
  if (!clean || clean.includes("/") || clean.includes("..")) {
    return fail("bad-request", `'${name}' is not a project name`);
  }
  await loadRegistry();
  let record = records.get(clean);

  if (!record) {
    // A new project is an OPFS project. A picked folder is adopted, never assumed: the user is
    // the only one who can say which folder on their machine this is.
    record = makeProjectRecord(clean, "browser");
    record.root = { kind: "opfs", path: `v1/projects/${clean}` };
    record.location = { kind: "opfs", path: `v1/projects/${clean}` };
  }

  const next = await storageFor(record);
  if ("ok" in next && next.ok === false) return next as Failure;

  const durability = record.root.kind === "opfs"
    ? {
        kind: "opfs" as const,
        persisted: await navigator.storage.persisted().catch(() => false),
        checkedAt: new Date().toISOString(),
      }
    : {
        kind: "handle" as const,
        persisted: await navigator.storage.persisted().catch(() => false),
        permission: await permission(record),
        checkedAt: new Date().toISOString(),
      };

  const fresh: ProjectRecord = {
    ...record,
    // Identity IS placement + location: `atlas` here is this origin's atlas, and the same name
    // elsewhere is another project. Nothing in this file tries to match them.
    id: `${clean}@browser`,
    lastUsed: new Date().toISOString(),
    durability,
  };

  current = fresh;
  storage = next as Storage;
  // Whether this root can hold its own files — asked BEFORE anything tries to write there, and
  // before the audit decides where it lives.
  const writableHere = fresh.root.kind === "opfs" || (await permission(fresh)) === "granted";
  auditFallback = fresh.root.kind === "handle" && !writableHere;
  if (fresh.root.kind === "opfs") {
    await storage.writeText(`${root()}/${ASSET_DIR}/.keep`, "");
    await storage.writeText(`${root()}/${AUDIT_DIR}/.keep`, "");
  } else if (writableHere) {
    await storage.writeText(`${root()}/${AUDIT_DIR}/.keep`, "");
  }
  // A picked folder the page may read but not write still opens, still lists and still reads —
  // and the audit goes to origin storage, which is a fact the header reports rather than a
  // difference nobody can see.
  await saveRegistry(fresh);
  await resumeFromEveryRoot();
  // A join is a presence beat: the log is how the other agent learns this one is here, and a beat is
  // the only thing that can age into "it stopped answering".
  await appendShared((base) => presenceEntry(base, "ready", `opened ${fresh.id}`));

  const { entries } = await storage.listChildren(`${root()}/${ASSET_DIR}`, LIST_LIMIT);
  const files = await storage.listChildren(root(), LIST_LIMIT);
  return {
    ok: true as const,
    // `root` on the wire is the VIRTUAL root string the tier table measures against, and
    // `rootKind` travels beside it: a record that cannot say which kind of root it has cannot
    // report an honest recovery story, and the page must not have to infer it from a string.
    project: {
      ...fresh,
      root: root(),
      rootKind: fresh.root.kind,
      auditLocation: auditFallback ? "this origin (the folder is read-only to the page)" : `${root()}/${AUDIT_DIR}/`,
    },
    // The gallery is the assets, not the host's own bookkeeping: `.keep` and `.undo.json` belong
    // to the environment, and showing them as assets would be showing the user our plumbing.
    // The explorer is the honest view of the root, and it shows everything.
    assets: entries.filter((e) => !e.name.startsWith(".")).map((e) => e.name),
    files: files.entries.map((e) => e.name),
  };
}

// ---------------------------------------------------------------- picked roots (N20)

async function adoptPicked(message: Record<string, unknown>): Promise<unknown> {
  const name = String(message.name ?? "").trim();
  const handle = message.handle as FileSystemDirectoryHandle | undefined;
  if (!name || !handle || handle.kind !== "directory") {
    return fail("bad-request", "adopting a picked root needs a project name and a directory handle");
  }

  // The handle is persisted, not held: that is the difference between "reachable tomorrow" and
  // "reachable until this tab closes".
  await idb.putHandle(name, handle);
  const state = await handle.queryPermission({ mode: "readwrite" }).catch(() => "denied" as const);
  const readState = await handle.queryPermission({ mode: "read" }).catch(() => "denied" as const);

  const existing = records.get(name);
  const record: ProjectRecord = {
    ...(existing ?? makeProjectRecord(name, "browser")),
    id: `${name}@browser`,
    name,
    placement: "browser",
    // A picked folder's location cannot be described by the origin — only remembered, with the
    // label the folder itself carries. A record that cannot say which kind of root it has cannot
    // report an honest recovery story, which is the named N20 failure.
    location: { kind: "handle", id: name, label: handle.name },
    root: { kind: "handle", id: name },
    capabilities: ["read", "write", "wasm"],
    undoKind: "written-file-list",
    lastUsed: new Date().toISOString(),
    durability: {
      kind: "handle",
      persisted: await navigator.storage.persisted().catch(() => false),
      permission: state,
      checkedAt: new Date().toISOString(),
    },
  };

  current = record;
  storage = handleStorage(handle, virtualRoot(record));
  const writableHere = state === "granted";
  auditFallback = !writableHere;
  if (writableHere) await storage.writeText(`${root()}/${AUDIT_DIR}/.keep`, "").catch(() => {});
  await saveRegistry(record);
  await resumeFromEveryRoot();

  return {
    ok: true as const,
    project: {
      ...record,
      root: root(),
      rootKind: record.root.kind,
      auditLocation: auditFallback ? "this origin (the folder is read-only to the page)" : `${root()}/${AUDIT_DIR}/`,
    },
    permission: state,
    readPermission: readState,
    persistable: false,
    needsGesture: state !== "granted",
  };
}

// ---------------------------------------------------------------- the tool run

async function loadSchema(): Promise<ToolSchema> {
  if (schema) return schema;
  schema = (await (await fetch(SCHEMA_URL)).json()) as ToolSchema;
  return schema;
}

async function createAsset(args: Record<string, unknown>, turn: string | null, tool = "create-asset") {
  requireCurrent();
  const unreachableHere = pageReachable();
  if (unreachableHere) return unreachableHere;
  const boundary = root();
  const name = typeof args?.name === "string" ? args.name : String(args?.name ?? "");
  const wouldBe = `${boundary}/${ASSET_DIR}/${name}`;

  const checked = validate(await loadSchema(), args);
  if (!checked.ok) {
    // A schema failure is a refusal with its own name, and it is an audit entry: a log that only
    // records well-formed attempts cannot answer "what did it try".
    await record({ kind: "write", target: wouldBe, tool }, "refuse", checked.rule, "refused", null, turn);
    return { ok: false as const, refused: true, rule: checked.rule, why: checked.why, decision: "refuse" };
  }

  const resolved = resolveInsideRoot(boundary, `${ASSET_DIR}/${checked.value.name}`);
  if (!resolved.ok) {
    await record({ kind: "write", target: wouldBe, tool }, "refuse", resolved.rule, "refused", null, turn);
    return { ok: false as const, refused: true, rule: resolved.rule, why: resolved.why, decision: "refuse" };
  }

  const verdict = decide({ kind: "write", target: resolved.path, tool }, { root: boundary });
  if (verdict.decision !== "allow") {
    await record({ kind: "write", target: resolved.path, tool }, verdict.decision, verdict.rule, "refused", null, turn);
    return {
      ok: false as const,
      refused: true,
      rule: verdict.rule,
      why: verdict.decision === "refuse" ? verdict.why : "this placement asks before that",
      decision: verdict.decision,
    };
  }

  // The root's own preconditions, checked before the run so a `prompt` handle refuses in words
  // instead of hanging on a dialog nothing can answer.
  const unreachable = await reachable();
  if (unreachable) {
    await record({ kind: "write", target: resolved.path, tool }, "refuse", unreachable.code, "refused", null, turn);
    return unreachable;
  }
  const blocked = await writable(name);
  if (blocked) {
    await record({ kind: "write", target: resolved.path, tool }, "refuse", blocked.code, "refused", null, turn);
    return blocked;
  }

  // The module is handed the path RELATIVE to the root, because that is the only kind of name
  // `resolveInsideRoot` takes — and the host re-resolves it on the way back, which is what makes
  // "the module cannot choose where to write" a mechanism rather than a promise.
  const relative = `${ASSET_DIR}/${checked.value.name}`;
  const body = encoder.encode(checked.value.body);
  const pathBytes = encoder.encode(relative);
  const running = instanceFor(await fetchModule(tool));

  // Place the validated fields in the module's linear memory and point it at them.
  const RECORD = 1024;
  const PATH_AT = 2048;
  const bodyAt = PATH_AT + pathBytes.length;
  const needed = bodyAt + body.length;
  memory = running.exports.memory as WebAssembly.Memory;
  if (memory.buffer.byteLength < needed) memory.grow(Math.ceil((needed - memory.buffer.byteLength) / 65536));
  const view = new DataView(memory.buffer);
  new Uint8Array(memory.buffer).set(pathBytes, PATH_AT);
  new Uint8Array(memory.buffer).set(body, bodyAt);
  view.setUint32(RECORD + 0, PATH_AT, true);
  view.setUint32(RECORD + 4, pathBytes.length, true);
  view.setUint32(RECORD + 8, bodyAt, true);
  view.setUint32(RECORD + 12, body.length, true);

  // What this agent is DOING, appended before the act so another agent sees it while it happens —
  // the difference between live state and a post-hoc log line.
  await appendShared((base) => activityEntry(base, `creating ${checked.value.kind} asset`, relative));

  notes = [];
  pendingWrite = null;
  let trap: string | null = null;
  try {
    (running.exports.run as (a: number, b: number) => void)(RECORD, 16);
  } catch (e) {
    // A trapping tool is a failed turn, not a failed host.
    trap = (e as Error)?.message ?? String(e);
  }

  const asked = pendingWrite as typeof pendingWrite;
  if (trap || !asked) {
    await record({ kind: "write", target: resolved.path, tool }, "allow", "writes-inside", "error", await storage!.observe(resolved.path), turn);
    return { ok: false as const, error: trap ?? "the module wrote nothing" };
  }

  // The module's own words for the path — re-resolved, and required to be the path the host
  // decided on. A module that names a different file is refused rather than followed.
  const modulePath = decodeSpan(asked.pathPtr, asked.pathLen);
  const moduleBytes = new Uint8Array(memory.buffer.slice(asked.dataPtr, asked.dataPtr + asked.dataLen));
  const recheck = resolveInsideRoot(boundary, modulePath);
  if (!recheck.ok || recheck.path !== resolved.path) {
    const why = recheck.ok ? `the module named '${modulePath}', not the '${relative}' the host decided on` : recheck.why;
    await record({ kind: "write", target: recheck.ok ? recheck.path : resolved.path, tool }, "refuse", "outside-root", "refused", null, turn);
    return { ok: false as const, refused: true, rule: "outside-root", why, decision: "refuse" };
  }

  try {
    await storage!.writeBytes(resolved.path, moduleBytes);
  } catch (e) {
    // The storage layer's own refusal (a stale handle, a revoked permission) is still a refusal
    // with a name, and still an audit entry.
    const error = e as Error;
    const code: FailureCode = error?.name === "NotAllowedError" ? "permission-denied" : "root-unreachable";
    await record({ kind: "write", target: resolved.path, tool }, "refuse", code, "refused", null, turn);
    return fail(code, `the write to '${resolved.path}' did not happen`, `${error?.name}: ${error?.message}`);
  }

  await rememberWritten(resolved.path);
  const observed = await storage!.observe(resolved.path);
  const entry = await record({ kind: "write", target: resolved.path, tool }, "allow", "writes-inside", "ok", observed, turn);

  return {
    ok: true as const,
    path: resolved.path,
    name: checked.value.name,
    kind: checked.value.kind,
    bytes: moduleBytes.length,
    notes,
    seq: entry.seq,
    observed,
  };
}

async function rememberWritten(path: string): Promise<void> {
  let list: string[] = [];
  try {
    list = JSON.parse(await storage!.readText(`${root()}/${UNDO_FILE}`)) as string[];
  } catch {
    list = [];
  }
  list.push(path);
  await storage!.writeText(`${root()}/${UNDO_FILE}`, JSON.stringify(list, null, 2)).catch(() => {});
}

async function fetchModule(key: string): Promise<ArrayBuffer> {
  const url = MODULES[key];
  if (!url) throw new Error(`'${key}' is not a module this host admits`);
  return await (await fetch(url)).arrayBuffer();
}

/**
 * THE ENFORCEMENT, written as a literal with two keys.
 *
 * A module that imports `fetch`, `import`, `eval` or anything else does not get a policy refusal —
 * it fails to LINK, because the host never hands those over. That is §1.7's import boundary in its
 * strongest form: the capability is not denied, it is absent. `HOST_IMPORTS` is the same object's
 * keys, so "exactly two, and these two" is checkable rather than asserted in prose.
 */
const HOST_IMPLEMENTATIONS = {
  writeFile: (pathPtr: number, pathLen: number, dataPtr: number, dataLen: number) => {
    pendingWrite = { pathPtr, pathLen, dataPtr, dataLen };
  },
  note: (msgPtr: number, msgLen: number) => {
    notes.push(decodeSpan(msgPtr, msgLen));
  },
};
const HOST_IMPORTS = Object.keys(HOST_IMPLEMENTATIONS);

/** Instantiate with exactly `HOST_IMPLEMENTATIONS` as `env`, and nothing else. */
function instanceFor(bytes: ArrayBuffer): WebAssembly.Instance {
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: HOST_IMPLEMENTATIONS });
}

// The synchronous import writes into this; the host drains it after run() returns.
let pendingWrite: { pathPtr: number; pathLen: number; dataPtr: number; dataLen: number } | null = null;
let notes: string[] = [];
let memory: WebAssembly.Memory | null = null;

function decodeSpan(ptr: number, len: number): string {
  if (!memory) return "";
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

// ---------------------------------------------------------------- tier 2: delete

async function requestDelete(args: { name?: unknown; turn?: string | null }) {
  requireCurrent();
  const unreachableHere = pageReachable();
  if (unreachableHere) return unreachableHere;
  const boundary = root();
  const resolved = resolveInsideRoot(boundary, `${ASSET_DIR}/${String(args?.name ?? "")}`);
  if (!resolved.ok) {
    await record({ kind: "delete", target: `${boundary}/${ASSET_DIR}/${String(args?.name ?? "")}`, tool: "delete-asset" }, "refuse", resolved.rule, "refused", null, args?.turn ?? null);
    return { ok: false as const, refused: true, rule: resolved.rule, why: resolved.why, decision: "refuse" };
  }
  const verdict = decide({ kind: "delete", target: resolved.path, tool: "delete-asset" }, { root: boundary });
  if (verdict.decision === "refuse") {
    await record({ kind: "delete", target: resolved.path, tool: "delete-asset" }, "refuse", verdict.rule, "refused", null, args?.turn ?? null);
    return { ok: false as const, refused: true, rule: verdict.rule, why: verdict.why, decision: "refuse" };
  }

  // The ask is itself an entry: "asked and not yet performed" is the truthful state, and a log
  // that only records answers cannot answer "what was it about to do, and was it allowed".
  const confirmId = `c${Date.now().toString(36)}-${pending.size + 1}`;
  pending.set(confirmId, { act: { kind: "delete", target: resolved.path, tool: "delete-asset" }, rule: verdict.rule, why: verdict.why });
  await record({ kind: "delete", target: resolved.path, tool: "delete-asset" }, "confirm", verdict.rule, "refused", await storage!.observe(resolved.path), args?.turn ?? null);

  return {
    ok: true as const,
    confirm: {
      id: confirmId,
      rule: verdict.rule,
      why: verdict.why,
      plan: { kind: "delete", target: resolved.path, name: String(args?.name ?? "") },
    },
  };
}

async function answer(confirmId: string, approved: boolean) {
  requireCurrent();
  const ask = pending.get(confirmId);
  if (!ask) return fail("bad-request", `confirm '${confirmId}' is not pending`);
  pending.delete(confirmId);

  if (!approved) {
    const entry = await record(ask.act, "confirm", ask.rule, "refused", await storage!.observe(ask.act.target));
    return { ok: true as const, answered: "declined", seq: entry.seq, observed: entry.observed };
  }

  const before = await storage!.observe(ask.act.target);
  const removed = await storage!.remove(ask.act.target);
  const observed = await storage!.observe(ask.act.target);
  const entry = await record(ask.act, "confirm", ask.rule, removed ? "ok" : "error", observed);
  return { ok: true as const, answered: "approved", removed, before, seq: entry.seq, observed };
}

// ---------------------------------------------------------------- read

async function readFile(args: { path?: unknown; turn?: string | null }) {
  requireCurrent();
  const unreachableHere = pageReachable();
  if (unreachableHere) return unreachableHere;
  stats.reads++;
  const boundary = root();
  const resolved = resolveInsideRoot(boundary, String(args?.path ?? ""));
  if (!resolved.ok) {
    await record({ kind: "read", target: `${boundary}/${String(args?.path ?? "")}` }, "refuse", resolved.rule, "refused", null, args?.turn ?? null);
    return { ok: false as const, refused: true, rule: resolved.rule, why: resolved.why, decision: "refuse" };
  }
  const verdict = decide({ kind: "read", target: resolved.path }, { root: boundary });
  // A root whose read permission has regressed to `prompt` fails here, by name and before
  // touching the file — the same precondition the write path checks, because a browser may keep
  // one mode and drop the other, and "cannot read this" must not arrive as "internal error".
  if (verdict.decision === "allow") {
    const blocked = await reachable();
    if (blocked) {
      await record({ kind: "read", target: resolved.path }, "refuse", blocked.code, "refused", null, args?.turn ?? null);
      return blocked;
    }
  }
  // A read that fails says which failure it was: swallowing it here would turn a revoked
  // permission, a missing file and a stale handle into one identical "no".
  let text: string | null = null;
  let detail: string | undefined;
  if (verdict.decision === "allow") {
    try {
      text = await storage!.readText(resolved.path);
    } catch (e) {
      detail = `${(e as Error)?.name}: ${(e as Error)?.message}`;
    }
  }
  const bytes = text === null ? 0 : encoder.encode(text).length;
  const entry = await record(
    { kind: "read", target: resolved.path },
    verdict.decision === "allow" ? "allow" : verdict.decision,
    verdict.rule,
    text === null ? "error" : "ok",
    await storage!.observe(resolved.path),
    args?.turn ?? null,
    [{ path: resolved.path, bytes }],
  );
  return { ok: text !== null, text, seq: entry.seq, bytes, ...(detail ? { code: "root-unreachable", why: `'${resolved.path}' could not be read`, detail } : {}) };
}

// ---------------------------------------------------------------- the explorer

/**
 * Three roots, three authorities, and the view must say which one it is showing (bead 7cd).
 *
 * `listView` answers with ONE bounded directory iteration. It never walks a tree and it never
 * issues a read per entry — the page that listed files by posting `read <name>` turns is exactly
 * the defect this shape prevents.
 */
/**
 * Resolve a listing target. An EMPTY path means the root itself, which is a legitimate thing to
 * list and not a candidate that escapes anything — the resolver refuses an empty candidate on
 * purpose, because a tool that names no file has named nothing.
 */
function listingTarget(candidate: unknown): { ok: true; path: string; rel: string } | { ok: false; rule: string; why: string } {
  const path = typeof candidate === "string" ? candidate : "";
  if (path === "" || path === ".") return { ok: true, path: root(), rel: "" };
  const resolved = resolveInsideRoot(root(), path);
  return resolved.ok ? { ok: true, path: resolved.path, rel: path } : resolved;
}

async function listView(message: Record<string, unknown>) {
  stats.listings++;
  const view = String(message.view ?? "opfs");
  const limit = Math.min(Number(message.limit ?? LIST_LIMIT) || LIST_LIMIT, 1000);
  const record = current;

  if (view === "server") {
    // The third authority: the ACTIVE ROOT as the machine sees it — the same root the loop writes
    // into, not a folder of its own. When the active root is one this process cannot reach, the view
    // says so by name instead of showing files from somewhere the project is not.
    const response = await fetch(SERVER_FILES_URL);
    if (!response.ok) return fail("root-unreachable", `the server view is unreachable (HTTP ${response.status})`);
    const body = (await response.json()) as Record<string, any>;
    if (body.ok === false) {
      return fail((body.refused as FailureCode) ?? "root-unreachable", String(body.why ?? "the loop cannot reach this root"), JSON.stringify(body.root ?? {}));
    }
    const entries: Entry[] = (body.entries ?? []).map((f: Record<string, any>) => ({
      name: String(f.name),
      kind: f.kind === "directory" ? "directory" : "file",
      bytes: f.bytes,
      mtime: f.mtime,
    }));
    return {
      ok: true as const,
      view,
      label: `the machine's root for '${body.project}'`,
      root: body.root?.path ?? "unknown",
      authority: {
        where: ROOT_FACTS.machine.where,
        whoCanSee: ROOT_FACTS.machine.whoCanSee,
        needsGesture: false,
        survivesTabClose: true,
      },
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
    };
  }

  if (!record) return fail("no-project", "no project is open, so there is no root to list");

  if (view === "picked") {
    // The KIND question first, then reachability: "this project has no picked folder" is a different
    // fact from "this placement cannot act on this project's root", and answering the second when the
    // first is true sends the reader looking for a permission problem that does not exist.
    if (record.root.kind !== "handle") {
      const what = record.root.kind === "machine"
        ? `a folder on the machine running the process (${record.root.path})`
        : "an OPFS project, whose root is this origin's private storage";
      return fail(
        "not-a-project",
        `'${record.name}' is ${what}: there is no picked folder to show. Open or adopt a picked folder to see this view`,
      );
    }
    const unreachable = await reachable();
    if (unreachable) return unreachable;
    const resolved = listingTarget(message.path);
    if (!resolved.ok) return { ...fail("bad-request", resolved.why), rule: resolved.rule };
    let listing;
    try {
      listing = await storage!.listChildren(resolved.path, limit, true);
    } catch (e) {
      const error = e as Error;
      // A directory that is not there and a folder the page may not open are different facts.
      const code: FailureCode = error?.name === "NotFoundError" ? "not-found" : "root-unreachable";
      return fail(code, `'${resolved.path}' could not be listed`, `${error?.name}: ${error?.message}`);
    }
    return {
      ok: true as const,
      view,
      path: resolved.rel,
      label: record.location.kind === "handle" ? record.location.label : record.name,
      root: root(),
      permission: await permission(record),
      authority: {
        where: "a real folder on this machine — the one the user picked",
        whoCanSee: "anything on this machine, and the user in their own editor",
        needsGesture: true,
        survivesTabClose: true,
      },
      ...listing,
    };
  }

  // The OPFS view: this origin's OWN storage tree (`v1/`), whatever kind of root the open project
  // has. It used to render the open project's root, which for a picked project is the picked
  // folder — two panels showing one directory under two headings, which is precisely the
  // "cannot tell what you are looking at" failure this view exists to prevent.
  const origin = await opfsStorage("v1");
  const originTarget =
    typeof message.path === "string" && message.path !== "" && message.path !== "."
      ? resolveInsideRoot("v1", message.path)
      : { ok: true as const, path: "v1" };
  if (!originTarget.ok) return { ...fail("bad-request", originTarget.why), rule: originTarget.rule };
  let originListing;
  try {
    originListing = await origin.listChildren(originTarget.path, limit, true);
  } catch (e) {
    const error = e as Error;
    return fail("not-found", `'${originTarget.path}' is not a directory in this origin's storage`, `${error?.name}: ${error?.message}`);
  }
  return {
    ok: true as const,
    view: "opfs",
    path: originTarget.path === "v1" ? "" : String(message.path),
    label: "this origin's storage",
    root: "v1",
    permission: "implicit",
    authority: {
      where: "this origin's private file system, inside the browser",
      whoCanSee: "nothing outside this origin — not even the user's own editor",
      needsGesture: false,
      survivesTabClose: true,
    },
    ...originListing,
  };
}

function requireCurrent(): ProjectRecord {
  if (!current) throw new Error("no project is open");
  return current;
}

// ---------------------------------------------------------------- the wire

type Message = { id?: number; type?: string } & Record<string, unknown>;

async function handle(message: Message) {
  switch (message.type) {
    case "hello": {
      await loadRegistry();
      return {
        ok: true as const,
        instance,
        actor,
        schema: (await loadSchema()).title,
        durability: { persisted: await navigator.storage.persisted().catch(() => false) },
        projects: [...records.values()].map((p) => ({
          name: p.name,
          id: p.id,
          rootKind: p.root.kind,
          root: virtualRoot(p),
        })),
        current: current ? current.name : null,
        currentRootKind: current ? current.root.kind : null,
      };
    }
    case "listProjects": {
      await loadRegistry();
      return {
        ok: true as const,
        projects: [...records.values()].map((p) => ({
          ...p,
          rootKind: p.root.kind,
          root: virtualRoot(p),
          permission: p.root.kind === "handle" ? p.durability?.permission : "implicit",
        })),
      };
    }
    case "openProject":
      return await openProject(String(message.name ?? ""));
    case "adoptPickedProject":
      return await adoptPicked(message);
    case "regrantPicked": {
      // The page has just asked for permission with a real gesture and hands the handle back.
      const name = String(message.name ?? "");
      const handle = message.handle as FileSystemDirectoryHandle | undefined;
      if (!handle) return fail("bad-request", "re-granting needs the handle back from the page");
      await idb.putHandle(name, handle);
      const state = await handle.queryPermission({ mode: "readwrite" }).catch(() => "denied" as const);
      if (state !== "granted") {
        const why = state === "denied"
          ? "the permission request was declined, so this folder cannot be written to"
          : "the browser still reports 'prompt' — the request did not carry a user gesture";
        return fail(state === "denied" ? "permission-denied" : "needs-gesture", why);
      }
      return await openProject(name);
    }
    case "handleState": {
      const name = String(message.name ?? "");
      const handle = await idb.getHandle(name).catch(() => null);
      if (!handle) {
        return fail(
          "handle-gone",
          `this browser holds no handle for '${name}' — a handle is per profile and per browser, so a different profile cannot open this folder without picking it again`,
        );
      }
      return {
        ok: true as const,
        name: handle.name,
        kind: handle.kind,
        permission: await handle.queryPermission({ mode: "readwrite" }).catch(() => "denied"),
      };
    }
    case "createAsset":
      return await createAsset(
        (message.args ?? {}) as Record<string, unknown>,
        (message.turn as string) ?? null,
        String(message.tool ?? "create-asset"),
      );
    case "deleteAsset":
      return await requestDelete({ name: message.name, turn: (message.turn as string) ?? null });
    case "answer":
      return await answer(String(message.confirmId ?? ""), Boolean(message.approved));
    case "readFile":
      return await readFile({ path: message.path, turn: (message.turn as string) ?? null });
    case "audit": {
      const entries = mergeAudit(await readAudit());
      return { ok: true as const, entries };
    }
    case "auditAll": {
      // One file per (root, writer), read as one view. The files are the storage; the merged read
      // claims only a (instance, seq) order, because two roots and two writers have no shared clock.
      await loadRegistry();
      const files = [];
      for (const project of records.values()) files.push(...(await logFilesFor(project)));
      return { ok: true as const, files, merged: mergeAudit(files.flatMap((f) => f.entries)) };
    }
    case "listView":
      return await listView(message);
    case "useMachineRoot":
      return await useMachineRoot(message);
    case "identify": {
      // §9's actor model: identity is nameable, and two agents in one project are two people. The
      // session travels because identity is claimed against it.
      instance = String(message.instance ?? "").trim() || instance;
      actor = {
        name: String((message.actor as Actor)?.name ?? instance),
        harness: (message.actor as Actor)?.harness ?? null,
        session: (message.actor as Actor)?.session ?? null,
        cwd: (message.actor as Actor)?.cwd ?? null,
      };
      await resumeFromEveryRoot();
      return { ok: true as const, instance, actor };
    }
    case "beat":
      return { ok: true as const, entry: await appendShared((base) => presenceEntry(base, (message.state as PresenceState) ?? "ready", message.note as string | undefined)) };
    case "activity":
      return { ok: true as const, entry: await appendShared((base) => activityEntry(base, String(message.doing ?? ""), message.target as string | undefined)) };
    case "look":
      return await look(message.mark !== false);
    case "stats":
      return { ok: true as const, ...stats };
    case "instantiateProbe": {
      // THE DIAGNOSTIC SEAM (check 5): instantiate one of the admitted modules through the SAME
      // import object the tool gets, and report the platform's own words. It never runs the
      // module and it can only name a module this host lists.
      const key = String(message.module ?? "");
      if (!MODULES[key]) return fail("bad-request", `'${key}' is not a module this host admits`);
      const bytes = await fetchModule(key);
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((i) => `${i.module}.${i.name}`);
      try {
        const probe = instanceFor(bytes);
        return { ok: true as const, instantiated: true, exports: Object.keys(probe.exports), imports, hostImports: HOST_IMPORTS };
      } catch (e) {
        return {
          ok: false as const,
          instantiated: false,
          imports,
          hostImports: HOST_IMPORTS,
          error: String((e as Error)?.message ?? e),
          errorName: (e as Error)?.name,
        };
      }
    }
    default:
      return fail("bad-request", `unknown message type '${String(message.type)}'`);
  }
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as Message;
  const id = message?.id ?? null;
  // A measurement must not measure itself: reading the counters is not work the counters count.
  if (message?.type !== "stats") stats.messages++;
  try {
    const result = await handle(message);
    (self as unknown as Worker).postMessage({ ...result, id });
  } catch (e) {
    // Nothing the page sends can take the host down. The reply is an error and the host is still
    // here for the next message — which is check 7, and the reason this catch exists.
    (self as unknown as Worker).postMessage({
      ...fail("root-unreachable", String((e as Error)?.message ?? e), (e as Error)?.stack),
      id,
    });
  }
};

export { wasmInstance };
