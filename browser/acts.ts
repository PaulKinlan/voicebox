// browser/acts.ts — the page-side executor: the environment page ANSWERS routed acts.
//
// THE OTHER HALF OF THE ROUTER (core/dispatch.ts). When the server cannot act on a root —
// a picked folder, or this origin's private storage — it asks the page over `/channel`, and
// this module performs the act through the project's real storage adapter and answers with
// OBSERVED FACTS (bytes read back from the world), never claims.
//
// THE DISCIPLINE, same as the server's, four rules and a boundary:
//
//   1. CONTAINMENT IS RE-RUN HERE. `resolveInRoot` against the page's OWN current project
//      descriptor — the server's resolved string is never trusted, and a call naming a root
//      this page does not own is refused `root-not-mine` (the page knows which project is
//      open; the server knows which root is active; the call must name the same one).
//   2. ONE COMMAND SET. The verbs are the executor's file verbs (write/read/list), keyed by
//      CORE_FS_VERBS from core/dispatch.ts — not a second catalogue. A verb outside the set
//      is refused by the door's attribution check before any act runs.
//   3. THE ACT IS RECORDED. The page is a WRITER in the root's own audit log — same entry
//      shape as core/audit.ts, per-instance seq, one file per (root, writer) — refusals
//      included. The entry's seq rides back in the answer so the server's result can say
//      where the record lives.
//   4. FAILURES HAVE NAMES, from the page-side family: needs-gesture, permission-denied,
//      handle-gone, root-unreachable, root-vanished — never an empty success, and a storage
//      error becomes a named refusal rather than a thrown wire.
//
// THE TRUST BOUNDARY (coord's condition, written where a reader finds it): the server cannot
// verify these acts by reading the files itself — the observation is THIS PAGE'S account of
// its own storage. That is admitted, and it is why the wire carries `observed` facts labelled
// `via: "page"` rather than a bare "done". What makes the account trustworthy in structure is
// that the same discipline governs it — containment, named refusals, and an audit entry read
// back from the world — and what limits it is stated rather than hidden: a dishonest page is
// out of scope for the mechanism, as every other seam in this system already says.
//
// PLACEMENT-NEUTRAL ON PURPOSE: this file imports core/ and lib/channel.mjs only. The
// browser pieces (storage adapter, permission check, audit writer, the WebSocket itself) are
// INJECTED by the worker (browser/worker.ts) — so the same module runs in a node test against
// a scratch directory, and what the browser test proves is the wiring, not re-proven logic.

import { createExecutorDoor } from "../lib/channel.mjs";
import { resolveInRoot, type RootDescriptor } from "../core/root.ts";
import { CORE_FS_DESCRIPTOR, CORE_FS_VERBS } from "../core/dispatch.ts";

/** The structural slice of browser/storage.ts this module uses — injected, never imported. */
export interface ActsStorage {
  readonly root: string;
  writeText(resolved: string, text: string): Promise<void>;
  readText(resolved: string): Promise<string>;
  appendLine?(resolved: string, line: string): Promise<void>;
  observe(resolved: string): Promise<{ exists: boolean; bytes?: number; mtime?: string }>;
  listChildren(resolved: string, limit: number, strict?: boolean): Promise<{ entries: { name: string; kind: string; bytes?: number }[]; truncated: boolean }>;
  probe(): Promise<void>;
}

export interface ActsHooks {
  /** The page's CURRENT project root — the only root this page may act on. */
  getCurrentDescriptor(): RootDescriptor | null;
  /** The storage adapter for the current project (null when the current root is not this page's). */
  getStorage(): ActsStorage | null;
  /** The worker's write preconditions (needs-gesture / permission-denied), or null when writable. */
  checkWritable(): Promise<{ ok: false; code: string; why: string } | null>;
  /** The worker's audit writer — same entry shape as core/audit.ts. */
  recordAct(
    act: { kind: string; target: string; tool?: string },
    decision: "allow" | "refuse",
    rule: string | null,
    result: string,
    observed: unknown,
    turn: string | null,
  ): Promise<{ seq?: number } | null>;
  /** The socket factory — the worker's default reaches `/channel` on this origin. */
  connect?(): ActsSocket;
  log?(line: string): void;
}

/** The slice of WebSocket this module uses, so a test can hand a fake. */
export interface ActsSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
}

const LIST_LIMIT = 200;
/** The audit's name for a routed act: the turn it arrived on (a tool call names its tool). */
const turnOf = (call) => (typeof call.args?.turn === "string" && call.args.turn ? call.args.turn : "channel");

function sameRoot(a: RootDescriptor, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const other = b as Record<string, unknown>;
  if (a.kind !== other.kind) return false;
  if (a.kind === "opfs" || a.kind === "machine") return a.path === other.path;
  return a.id === other.id;
}

/** The executor: one call in, one result out — named refusals, observed facts. */
async function performAct(call: { tool: string; args: Record<string, unknown> }, hooks: ActsHooks) {
  const descriptor = hooks.getCurrentDescriptor();
  if (!descriptor) {
    return { ok: false as const, refused: "no-project", why: "this page has no project open, so there is no root it can act on — open the project in the environment page and the turn will land" };
  }
  if (call.args?.root !== undefined && !sameRoot(descriptor, call.args.root)) {
    return { ok: false as const, refused: "root-not-mine", why: `the call names a root this page does not own — this page acts on '${descriptor.kind}:${"path" in descriptor ? descriptor.path : descriptor.id}', and the active root belongs to a different page or project` };
  }
  // AN UNNAMED ROOT MEANS "THE PROJECT THIS PAGE HOLDS" (voicebox-beads-fqq). A call that NAMES a root
  // is still checked against this page's own — root-not-mine is what stops the server aiming this page
  // at storage it does not own, and it stays above every act. A call that names NO root is not naming a
  // different one: it is the room asking the page for the project the page itself holds, which is the
  // only part of the system that can answer when no server root is declared. Everything below resolves
  // against the descriptor found HERE, never against anything the caller sent.
  const storage = hooks.getStorage();
  if (!storage) {
    return { ok: false as const, refused: "root-not-reachable-from-here", why: "this page's current root is not one it has a storage adapter for — the act belongs to the other side, and it was routed here by mistake" };
  }

  const name = String(call.args?.name ?? "");
  const tool = call.tool;

  // A list never touches a path — but it still answers from the WORLD, with the platform's own
  // error naming a vanished root rather than an empty list that looks like an empty folder.
  if (tool === "list") {
    try {
      await storage.probe();
      const { entries, truncated } = await storage.listChildren(storage.root, LIST_LIMIT, true);
      const visible = entries.filter((e) => !e.name.startsWith("."));
      return {
        ok: true as const,
        files: visible.map((e) => e.name),
        entries: visible.map((e) => ({ name: e.name, bytes: e.bytes ?? 0 })),
        truncated,
        // WHO ANSWERED, AND FROM WHICH ROOT (fqq): the server cannot see this page's storage, so the
        // page's own descriptor is the only honest provenance for a listing it returns. The room prints
        // it, which is why a listing with no server root can still say whose files these are.
        root: descriptor,
      };
    } catch (e) {
      return { ok: false as const, refused: "root-unreachable", why: `the root cannot be listed: ${(e as Error)?.message ?? e} — the folder may be gone, renamed, or unmounted` };
    }
  }

  // CONTAINMENT, RE-RUN HERE (rule 1): the page resolves against its own descriptor.
  const resolved = resolveInRoot(descriptor, name);
  if (!resolved.ok) {
    await hooks.recordAct({ kind: tool, target: name, tool: "turn" }, "refuse", "outside-root", "refused", { exists: false }, turnOf(call));
    return { ok: false as const, refused: "outside-root", why: resolved.why };
  }
  // THE SAME LINE AS THE SERVER'S VERBS: containment first, then a hidden file inside the
  // root is refused — the listing hides dotfiles and so do the verbs, whichever placement
  // executes them. One rule, one vocabulary, two writers.
  const base = resolved.path.split("/").pop() ?? "";
  if (base.startsWith(".")) {
    await hooks.recordAct({ kind: tool, target: name, tool: "turn" }, "refuse", "dotfile-refused", "refused", { exists: false }, turnOf(call));
    return { ok: false as const, refused: "dotfile-refused", why: "dotfiles are neither readable nor writable through the loop — the listing hides them and so does this verb; host secrets live behind that line" };
  }

  if (tool === "write") {
    // THE SAME REFUSAL AS THE SERVER'S, one channel away: a write with ABSENT content is not
    // an empty write — it is a malformed act, refused by name, and the file is UNTOUCHED
    // (the review's worst outcome; absent ≠ empty, and `""` remains a valid empty file).
    if (call.args?.content == null) {
      await hooks.recordAct({ kind: "write", target: name, tool: "turn" }, "refuse", "missing-content", "refused", { exists: false }, turnOf(call));
      return { ok: false as const, refused: "missing-content", why: `the write to '${name}' carried no content — pass content explicitly (an empty string is a valid, intentional empty file). The existing file was NOT touched.` };
    }
    const unwritable = await hooks.checkWritable();
    if (unwritable) {
      await hooks.recordAct({ kind: "write", target: name, tool: "turn" }, "refuse", unwritable.code, "refused", { exists: false }, turnOf(call));
      return { ok: false as const, refused: unwritable.code, why: unwritable.why };
    }
    const content = String(call.args.content);
    try {
      await storage.writeText(resolved.path, content);
    } catch (e) {
      await hooks.recordAct({ kind: "write", target: name, tool: "turn" }, "refuse", "root-unreachable", "refused", { exists: false }, turnOf(call));
      return { ok: false as const, refused: "root-unreachable", why: `the write did not land: ${(e as Error)?.message ?? e}` };
    }
    // OBSERVED, never claimed: the bytes are read back from the world after the write.
    const observed = await storage.observe(resolved.path);
    const entry = await hooks.recordAct({ kind: "write", target: name, tool: "turn" }, "allow", "writes-inside", "ok", observed, turnOf(call));
    return { ok: true as const, name, bytes: observed.bytes ?? content.length, mtime: observed.mtime ?? null, auditSeq: entry?.seq ?? null };
  }

  if (tool === "read") {
    let content: string;
    try {
      content = await storage.readText(resolved.path);
    } catch {
      await hooks.recordAct({ kind: "read", target: name, tool: "turn" }, "refuse", "not-found", "refused", { exists: false }, turnOf(call));
      return { ok: false as const, refused: "not-found", why: `'${name}' is not in this project` };
    }
    const observed = await storage.observe(resolved.path);
    const entry = await hooks.recordAct({ kind: "read", target: name, tool: "turn" }, "allow", "reads-inside", "ok", observed, turnOf(call));
    return { ok: true as const, name, content, bytes: observed.bytes ?? content.length, auditSeq: entry?.seq ?? null };
  }

  // Unreachable: the door's attribution check refuses non-CORE_FS verbs first — this is the
  // belt to its braces, and it is a refusal, not a guess.
  return { ok: false as const, refused: "unknown-verb", why: `'${tool}' is not a file act this page performs (${[...CORE_FS_VERBS].join(", ")})` };
}

/**
 * Start answering routed acts. Returns a handle whose `connected()` the worker can report
 * against (the room's "the page that owns this root is not open" state has its mirror here).
 */
export function startActs(hooks: ActsHooks) {
  const log = hooks.log ?? (() => {});
  const door = createExecutorDoor({
    // Attribution: the built-in file descriptor, the file verbs only, no bounds.
    lookup: (descriptorId: string, tool: string) =>
      descriptorId === CORE_FS_DESCRIPTOR && CORE_FS_VERBS.has(tool) ? { bounds: {} } : null,
    exec: (call: { tool: string; args: Record<string, unknown> }) => performAct(call, hooks),
  });

  const connect =
    hooks.connect ??
    (() => {
      // In the worker: the channel endpoint on this origin (the constructor maps http→ws).
      const url = new URL("/channel", (self as unknown as { location: URL }).location.href);
      return new WebSocket(url) as unknown as ActsSocket;
    });

  let socket: ActsSocket | null = null;
  let stopped = false;

  function open() {
    if (stopped) return;
    socket = connect();
    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: "hello", role: "environment" }));
      log("[acts] connected to /channel — this page answers routed acts for its current root");
    };
    socket.onmessage = async (ev) => {
      const answer = await door.receive(typeof ev.data === "string" ? ev.data : String(ev.data));
      // null means unparseable garbage with no callId — the asker's timeout is the honest
      // outcome of shouting into noise (the door's contract, kept).
      if (answer !== null) socket?.send(answer);
    };
    socket.onclose = () => {
      socket = null;
      // The page dying with the tab is a limit stated in the design; a close HERE is the
      // transport, not the tab — so reconnect, and let the server's no-page family cover
      // the gap honestly.
      setTimeout(open, 2000);
    };
  }
  open();

  return {
    connected: () => socket !== null,
    stop() {
      stopped = true;
      socket?.close();
    },
    /** Exposed for tests: the door itself, no socket required. */
    door,
  };
}
