#!/usr/bin/env node
// voicebox server — the thinnest host for the loop:
//   browser captures a spoken turn -> POST /api/turn -> resolver -> action -> executor.
// Zero dependencies: node:http for the server, node:fs for the workspace.
// The resolver is a provider seam (lib/resolver.mjs) — swap it, don't rewrite the server.
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTurn } from "./lib/resolver.mjs";
import { ROOT_FACTS, ROOT_NOT_DECLARED, describeRoot, noRootDeclared, reachableFrom, reachableFromEnvironment, resolveInRoot, rootVanished } from "./core/root.ts";
import { CORE_FS_DESCRIPTOR, dispatchFor } from "./core/dispatch.ts";
import { createChannel } from "./lib/channel.mjs";
import {
  AGENT_BASE_INSTRUCTION,
  DEFAULT_AGENT_SETTINGS,
  PERSONALITIES,
  PROVIDERS,
  composeAgentInstruction,
  validateAgentSettings,
} from "./core/agent-settings.ts";
import { auditFileName, makeEntry, mergeAudit, nextSeq, parseEntry, resumeSeq, serializeEntry, sweepLostAttempts } from "./core/audit.ts";
import { activityEntry } from "./core/shared-log.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  ENV_UNREACHABLE,
  listUnreadable,
  parseEnvironment,
  unreachable,
} from "./core/environment.ts";
import * as extensions from "./lib/extensions.mjs";
import { createTaskHost, protectedAuditPath, TASK_TOOLS } from "./lib/tasks.mjs";
import { createPermissionPolicy } from "./lib/permission-policy.mjs";
import { bootFence } from "./lib/fence-provider.mjs";
import { SOURCE_DIRS } from "./lib/browser-sources.mjs";
import { upgrade as wsUpgrade } from "./lib/ws-server.mjs";
import { createLiveSession, LIVE_MODEL, inputRateRequiredBy } from "./lib/live-session.mjs";
import { commandToAction, functionDeclarations, liveSystemInstruction } from "./lib/commands.mjs";

// Module-relative, decoded: `new URL(...).pathname` percent-encodes spaces and
// silently points every read at a directory that does not exist.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Movable workspace (tests point it at scratch; see lib/extensions.mjs).
const WORKSPACE = process.env.VOICEBOX_WORKSPACE ?? path.join(ROOT, "workspace");

// ── THE ACTIVE ROOT (core/root.ts is the seam) ────────────────────────────────────────────────
// The loop does not invent a root, and it has NO DEFAULT. It acts on the ACTIVE PROJECT'S root,
// which the environment declares (POST /api/root) and which may be any of the three kinds. Two of
// them this process cannot reach, and it says so by name rather than quietly writing somewhere else.
//
// WHY THERE IS NO DEFAULT CONSULTED WHEN NOBODY DECLARED ONE: a default is a decision nobody made,
// and `workspace/` was exactly that — the second root the one-root change was supposed to retire,
// still sitting there as the thing a fresh placement falls back to. So the absence is an explicit,
// NAMED state (`root-not-declared`, whose why names the side that declares one) and no act happens.
//
// `VOICEBOX_WORKSPACE` still exists, but as a DECLARATION rather than a default: an operator who
// sets it has said where the files are, which is the same thing the environment says over HTTP.
// THE DEFAULT ROOT, and the note that belongs with it (isocan-wasm, review of e1m0/one-root):
// the default stays a machine root at `workspace/`, and THREE test files depend on that literal —
// channel.test.mjs:18, extensions.test.mjs:28/83 and voicebox.test.mjs:25. They are isolated (each
// spawns its own server on its own port, so no lane's declaration reaches them) and they exercise
// the default root, which is correct today. If the default ever stops being `workspace/`, those
// three are the readers that need the same treatment the retired "escapes the workspace" message
// got — a grep for the old literal is the check, and it should be run before changing this line.
/** null until somebody declares one — see the note above: no default is consulted when it is null. */
let active = null;

// ── THE ENVIRONMENT REGISTRY (core/environment.ts is the seam) ───────────────────────────────
// The list of hosts the page can act in, SERVER-OWNED so it is the same from every browser (Paul:
// "I might open the web page from many browsers so we lose client-side storage but sync on
// environments via server"). One file, one writer (this process), atomic. It lives in the server's
// own workspace so no active root has to exist and the list never depends on a project.
//
// THE TWO ABSENCES ARE DISTINCT, one level up from the root seam's pair: an unreadable registry file
// (`environment-list-unreadable` — fix the file) is not an unreachable host (`environment-unreachable`
// — start the service), and neither is the empty state (a fresh server, no environments yet — not an
// error at all). A list that showed a host that is not there without saying so would be the same
// defect as a footer promising files the live path could not write.
const ENV_FILE = path.join(WORKSPACE, "environments.json");

/** Read the registry. An absent file is the empty list; an unreadable/corrupt file is the named refusal. */
function readEnvironments() {
  if (!existsSync(ENV_FILE)) return { ok: true, environments: [], declared: false };
  try {
    const parsed = JSON.parse(readFileSync(ENV_FILE, "utf8"));
    const list = Array.isArray(parsed?.environments) ? parsed.environments : [];
    return { ok: true, environments: list, declared: true };
  } catch (err) {
    return { ok: false, ...listUnreadable(err?.message ?? "it is not JSON") };
  }
}

/** Write the registry atomically (tmp + rename), so a crashed write never leaves a torn list. */
function writeEnvironments(environments) {
  mkdirSync(WORKSPACE, { recursive: true });
  const tmp = `${ENV_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ environments }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
}

// ── AUTO-PROBE: the environment's capability report, observed and recorded ──────────────────────
// The probe script ships in tools/ so the harness runs the SAME probe the survey measured, not a
// copy. The report is cached next to the registry so the list can show it without re-running code
// on every read; the `when` inside it is the freshness marker.
const PROBE_FILE = path.join(WORKSPACE, "probe.json");
const PROBE_SCRIPT = path.join(ROOT, "tools", "sandbox-probe.mjs");

// ── PAIRING CUSTODY: the bearer, held host-side, OUT OF EVERY ROOT, never by the page ──────────
// The store lives in the host's OWN directory — the same sidecar pattern as the extension host
// token — NOT in the workspace, which is a root the page can write (and read). A bearer file inside
// a writable root is a credential the page can reach; 0600 and no-route are necessary but the
// LOCATION is the defence. A corrupt store is a NAMED refusal (every credential is not "no
// credentials"), in the family of environment-list-unreadable.
const HOST_DIR = process.env.VOICEBOX_EXTENSIONS_DIR ?? path.join(ROOT, "extensions");
const PAIRINGS_FILE = path.join(HOST_DIR, ".pairings.json");

const PAIRINGS_UNREADABLE = "pairing-list-unreadable";
function readPairings() {
  if (!existsSync(PAIRINGS_FILE)) return { ok: true, map: {} };
  try {
    const parsed = JSON.parse(readFileSync(PAIRINGS_FILE, "utf8"));
    return { ok: true, map: parsed && typeof parsed === "object" ? parsed : {} };
  } catch (err) {
    return { ok: false, refused: PAIRINGS_UNREADABLE, why: `the pairing store could not be read — ${err?.message ?? "it is not JSON"}. Fix or remove ${PAIRINGS_FILE} rather than assuming nothing is paired` };
  }
}

function writePairings(map) {
  mkdirSync(HOST_DIR, { recursive: true });
  writeFileSync(PAIRINGS_FILE, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}

/** The bearer THIS host holds for calling the named environment (local side of a pairing). */
function bearerFor(envKey) {
  const read = readPairings();
  if (!read.ok) return null;
  const entry = read.map[envKey];
  if (!entry || entry.revoked) return null;
  return entry.callBearer ?? null;
}

/** Store the bearer this host will ACCEPT for itself (the remote side of a pairing). */
function storeBearer(envKey, bearer) {
  const read = readPairings();
  const map = read.ok ? read.map : {};
  const prev = map[envKey] ?? {};
  map[envKey] = {
    ...prev,
    acceptBearer: bearer,
    revoked: false,
    revokedAt: null,
    issuedAt: new Date().toISOString(),
  };
  writePairings(map);
}

/** Check a bearer presented to THIS host against the one it issued for that environment key. */
function bearerOk(envKey, bearer) {
  const read = readPairings();
  if (!read.ok) return { ok: false, refused: read.refused, why: read.why };
  const entry = read.map[envKey];
  if (!entry) return { ok: false, refused: "unauthenticated-call", why: "this environment is not paired" };
  if (entry.revoked || entry.revokedBearers?.includes(bearer)) {
    return { ok: false, refused: "pairing-revoked", why: `the pairing for environment '${envKey}' was revoked by the host` };
  }
  const held = entry.acceptBearer;
  if (typeof held === "string" && held.length > 0 && typeof bearer === "string" && bearer === held) {
    return { ok: true, envKey };
  }
  return { ok: false, refused: "unauthenticated-call", why: "a proxied call must carry the bearer this environment issued at pairing — it is checked before any tool runs" };
}

/**
 * Does THIS host accept this bearer for ANY environment key it has issued one for?
 * Returns { ok: true, envKey } or { ok: false, refused, why }.
 */
function checkBearerAccepted(bearer) {
  if (typeof bearer !== "string" || bearer.length === 0) {
    return { ok: false, refused: "bearer-refused", why: "bearer is missing or empty" };
  }
  const read = readPairings();
  if (!read.ok) return { ok: false, refused: read.refused, why: read.why };

  // 1. Active bearer on any environment?
  for (const [envKey, entry] of Object.entries(read.map)) {
    if (!entry?.revoked && entry?.acceptBearer === bearer) {
      return { ok: true, envKey };
    }
  }

  // 2. Previously issued and revoked?
  for (const [envKey, entry] of Object.entries(read.map)) {
    if (entry?.revoked || entry?.revokedBearers?.includes(bearer)) {
      if (entry?.acceptBearer === bearer || entry?.revokedBearers?.includes(bearer)) {
        return {
          ok: false,
          refused: "pairing-revoked",
          why: "this pairing was revoked by the host — re-pair first (POST /api/pair) to establish a new credential",
        };
      }
    }
  }

  // 3. Never issued
  return {
    ok: false,
    refused: "bearer-refused",
    why: "that bearer is not one this host issued. Pair first (POST /api/pair with the host token) and send " +
      "the bearer it returns as the hello frame's `bearer` — a session is not created for a peer we cannot identify.",
  };
}

function bearerAcceptedByThisHost(bearer) {
  return checkBearerAccepted(bearer).ok;
}

/** Record the bearer the LOCAL host uses when calling a paired environment. */
function recordCallBearer(envKey, bearer) {
  const read = readPairings();
  const map = read.ok ? read.map : {};
  map[envKey] = { ...(map[envKey] ?? {}), callBearer: bearer };
  writePairings(map);
}

/** Resolve an environment key to its origin, from the registry. A key nobody declared is a refusal. */
/**
 * **THIS host's self-issued environment key** (`voicebox-beads-4x7`, plan §1).
 *
 * A key, not a label — and NOT a value every host spells the same way. The
 * first version of this was the constant `"local"`, shared by every server, so
 * a descriptor posted to two hosts was re-stamped to the same string on each
 * and no real path could produce a root whose owner differed from the acting
 * environment. `not-reachable-from-this-environment` shipped, was correct, and
 * could never fire: a refusal that cannot fire is a claim, not a gate.
 *
 * Minted once and kept in the host's own directory beside its token (0600),
 * then read back on every boot — an identity that changed on restart would
 * make yesterday's declared root belong to nobody today.
 *
 * NOT to be conflated with `resolveEnvironment("local")`, which is a ROUTING
 * name ("the host answering on this machine"), not an identity.
 */
const SELF_KEY_FILE = path.join(HOST_DIR, ".environment-key");
function selfEnvironmentKey() {
  try {
    const held = readFileSync(SELF_KEY_FILE, "utf8").trim();
    if (/^env_[0-9a-f]{16}$/.test(held)) return held;
  } catch {
    // Not minted yet (or unreadable): mint below rather than fall back to a
    // shared string — falling back would restore the defect silently.
  }
  const minted = `env_${randomBytes(8).toString("hex")}`;
  mkdirSync(HOST_DIR, { recursive: true });
  writeFileSync(SELF_KEY_FILE, minted + "\n", { mode: 0o600 });
  return minted;
}
const SELF_ENVIRONMENT = selfEnvironmentKey();

async function resolveEnvironment(envKey) {
  if (envKey === "local") {
    return { ok: true, label: "this machine", origin: null, local: true };
  }
  const stored = readEnvironments();
  if (!stored.ok) return stored;
  const env = stored.environments.find((e) => e.key === envKey);
  if (!env) {
    return { ok: false, refused: "unknown-environment", why: `no environment with key '${envKey}' is in the registry — declare it (the "+" button) before calling it` };
  }
  return { ok: true, label: env.label, origin: env.origin };
}

function readProbeCache() {
  try {
    const parsed = JSON.parse(readFileSync(PROBE_FILE, "utf8"));
    return parsed && typeof parsed === "object" && parsed.when ? parsed : null;
  } catch {
    return null;
  }
}

function writeProbeCache(report) {
  mkdirSync(WORKSPACE, { recursive: true });
  writeFileSync(PROBE_FILE, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

/** Run the probe in THIS process's environment. JSON on stdout; a non-zero exit is the boundary
 *  showing itself, and any stdout it produced is still the report. */
function runProbe() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE_SCRIPT], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout ?? "").trim();
      if (!text) return reject(err ?? new Error("the probe printed nothing"));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(err ?? new Error("the probe printed something that was not JSON"));
      }
    });
  });
}

/**
 * The probe's act, in the environment's own audit — because it ran unprompted, and the record is
 * what lets the system say so. An `activity` entry, not an `act`: no tier decision was made. The
 * write is best-effort (the probe's answer is the route's job; the audit is the record's), and it
 * is skipped rather than invented when this process has no loggable root.
 */
function recordProbeAct(report) {
  if (!loggableRoot()) return;
  try {
    const dir = path.join(active.root.path, ".audit");
    mkdirSync(dir, { recursive: true });
    const file = auditPathFor(active.root);
    resumeLog();
    const base = {
      seq: nextSeq(),
      instance: INSTANCE,
      actor: { name: "voicebox-server", harness: "voicebox", session: null, cwd: ROOT },
      project: active.project,
      root: `machine:${active.root.path}`,
      turn: null,
      at: new Date().toISOString(),
    };
    const entry = activityEntry(base, "probed itself (auto-probe)", `sandbox-probe @ ${report.when ?? "unknown time"}`);
    appendFileSync(file, `${serializeEntry(entry)}\n`);
  } catch {
    // A record that cannot be written must not fail the probe — but the route's answer stands on its own.
  }
}

/**
 * The registry, with each entry's reachability PROBED LAZILY (on read) rather than at declaration.
 * The local server this process is on is always a row; remote rows are probed over HTTP. A host that
 * does not answer is named unreachable, never silently shown as ready.
 */
async function environmentsWithStatus() {
  const stored = readEnvironments();
  if (!stored.ok) return stored;
  // The local server is an implicit row: this host, reachable by construction, ambient on loopback.
  const local = {
    key: "local",
    label: `this machine: ${os.hostname() || "localhost"}`,
    kind: "server",
    origin: "same-origin",
    home: active ? active.root : null,
    // The probe report, if this host has probed itself: the boundary and the capability are the SAME
    // observed report, split by what they answer (boundary: what is fenced; capability: what is present).
    boundary: readProbeCache(),
    capability: readProbeCache(),
    reach: "ambient",
    reachable: true,
    refused: null,
    why: null,
  };
  const rows = [local];
  for (const env of stored.environments) {
    // boundary/capability are OBSERVED, never inherited from the file: the probe is the ONLY writer
    // of those fields, so a hand-edited or stale descriptor cannot echo a claim as a measurement.
    // A stored row arrives here with both re-nulled — EXCEPT a report the probe itself wrote (a
    // fence's boot-time boundary, provenance-tagged measuredBy:"probe"), which is trusted because it
    // is a measurement, not a claim. Its `when` travels with it, so a stale one reads as stale.
    const probeMeasured = env.boundary?.measuredBy === "probe";
    const declared = probeMeasured ? { ...env } : { ...env, boundary: null, capability: null };
    if (env.kind === "fence") {
      // A fence BOOTS, probes, and exits — it is a provider, not a standing service, so its row says
      // so rather than reading "unreachable" (which would look like a failure). A persistent fenced
      // service is the next slice; today the honest state is that the boundary was measured at boot.
      rows.push({ ...declared, reachable: null, refused: null, why: "a fence boots, probes, and exits — its boundary was measured at boot; it is not a standing service" });
      continue;
    }
    if (env.kind !== "server" || !env.origin) {
      rows.push({ ...declared, reachable: null, refused: null, why: "the browser environment is always present" });
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const answer = await fetch(`${env.origin}/api/health`, { signal: controller.signal }).finally(() => clearTimeout(timer));
      const no = unreachable(env.label, env.origin);
      rows.push({ ...declared, reachable: answer.ok, refused: answer.ok ? null : no.refused, why: answer.ok ? null : no.why });
    } catch {
      const no = unreachable(env.label, env.origin);
      rows.push({ ...declared, reachable: false, refused: no.refused, why: no.why });
    }
  }
  return { ok: true, environments: rows, declared: true };
}

// ── THE AGENT'S OWN SETTINGS (provider · voice · personality) ─────────────────────────────────
// Kept in memory, and the payload SAYS SO rather than implying durability: a restart resets the
// request, and a person can see that instead of discovering it.
// (No type annotation here: this file is plain JS. The shapes live in core/agent-settings.ts, and
// the module is imported for its values — a `type` import would be a syntax error in a .mjs file,
// which is worth knowing because node --check is how you find that out.)
let agentSettings = { ...DEFAULT_AGENT_SETTINGS };

/** What a LIVE session actually started with — the difference between "stored" and "in use". */
let runningSession = null;
// THE REAL PORT, once it is known: `PORT` may be 0 (the OS picks), so anything that has to recognise this
// server's own origin must ask for the BOUND port, not the requested one.
let boundPort = null;
// MONOTONIC, and it counts ATTEMPTS: a session that is created and then fails to connect is still
// provider spend, and this number is what makes 'nothing was created' assertable from outside.
let liveSessionsCreated = 0;

/** A declaration made by the operator at boot (VOICEBOX_WORKSPACE), which is a decision, not a default. */
if (process.env.VOICEBOX_WORKSPACE) {
  const declared = path.resolve(process.env.VOICEBOX_WORKSPACE);
  if (existsSync(declared) && statSync(declared).isDirectory()) {
    active = { project: path.basename(declared), root: { kind: "machine", path: realpathSync(declared), environment: SELF_ENVIRONMENT }, declaredAt: new Date().toISOString(), declaredBy: "VOICEBOX_WORKSPACE" };
  } else {
    console.error(`[root] VOICEBOX_WORKSPACE='${process.env.VOICEBOX_WORKSPACE}' is not a directory — no root is declared`);
  }
}

// This process is a WRITER of the root it acts on, so it keeps its own file in that root's log —
// one file per (root, writer), which is what the log has always meant. Without this the loop would
// be a stranger writing into somebody's project with no record of what it did, and the machine root
// would be the one root in the product with no audit at all.
const INSTANCE = process.env.VOICEBOX_INSTANCE ?? "machine";
// The process generation: an ATTEMPT entry carries it, so the next boot can tell
// "pending from a dead process" (attempted-and-lost) from "pending right now" (in flight).
const BOOT = randomBytes(8).toString("hex");

const tasks = createTaskHost({
  environment: SELF_ENVIRONMENT, instance: INSTANCE, boot: BOOT,
  addressKey: readFileSync(path.join(HOST_DIR, ".host-token")),
  root: () => active,
});

const permissions = createPermissionPolicy();

function callTool(tool, args, authority) {
  return TASK_TOOLS.has(tool) ? tasks.call(tool, args, authority) : extensions.callTool(tool, args);
}

/**
 * The log lives WITH THE ROOT, and only for a root this process can actually name.
 *
 * The guard is not defensive decoration: a root of kind `opfs` or `handle` carries a VIRTUAL path
 * (`v1/projects/atlas`, or a project name), and `path.join` on it produced a real directory inside
 * whatever the process's cwd happened to be. That is how a test run came to commit its own audit
 * files into the repository — an instrument writing into the thing it measures.
 */
function loggableRoot() {
  return active && active.root.kind === "machine" && path.isAbsolute(active.root.path);
}

function auditPathFor(root) {
  return path.join(root.path, ".audit", auditFileName(INSTANCE, `machine:${root.path}`));
}

/** Read this writer's file back so `seq` continues instead of restarting on every restart. */
function resumeLog() {
  // THE CONTINUITY RULE (found reviewing the attempted-and-lost wiring, 2026-09-20): ENOENT
  // means "no log yet" and a fresh sequence is correct; ANY OTHER read failure means a log
  // EXISTS and its continuation is UNKNOWN — resequencing there would hand fresh numbers to
  // entries that have ancestors, corrupting the (instance, seq) order. So: fresh is silent,
  // unknown is a NAMED throw (audit-unreadable), and the entry is not written — logged:null
  // on the response, the audit's absence visible, never a silent fork of the order.
  const file = auditPathFor(active.root);
  let entries;
  try {
    entries = readFileSync(file, "utf8").split("\n").map(parseEntry).filter(Boolean);
  } catch (err) {
    if (err?.code === "ENOENT") {
      resumeSeq([], INSTANCE); // genuinely fresh
      entries = [];
    } else {
      throw Object.assign(new Error(`the audit log exists but could not be read: ${err?.message ?? err} — appending with a reset sequence would corrupt the (instance, seq) order`), { refused: "audit-unreadable" });
    }
  }
  resumeSeq(entries, INSTANCE);
  // THE BOOT SWEEP (voicebox-beads-y69): an ATTEMPT left pending by a previous generation
  // is attempted-and-lost — completed BY NAME now, because after a crash "whether it landed"
  // is unknown and must not silently read as either success or refusal. Idempotent: a lost
  // completion claims the attempt, so the sweep never reports it twice.
  for (const d of sweepLostAttempts(entries, BOOT)) {
    const lost = makeEntry(active.project, `machine:${active.root.path}`, INSTANCE,
      { name: "voicebox-server", harness: "voicebox", session: null, cwd: ROOT },
      d.act, "lost", "attempted-and-lost", "lost", null);
    lost.attempt = d.attempt;
    lost.boot = BOOT;
    appendFileSync(auditPathFor(active.root), `${serializeEntry(lost)}\n`);
  }
}

/** Append one entry. A refusal is an entry too: a log of successes cannot answer "what did it try". */
let lastLogRefusal = null; // the named reason the last entry was not written (audit-unreadable), visible to callers

function logAct(act, decision, rule, result, observed, turn = null, attempt = null) {
  if (!loggableRoot()) {
    // Not silently skipped: the caller reports `logged: null` and `logRefused`, so the missing entry
    // is a fact on the response rather than a hole in the record.
    return null;
  }
  try {
    resumeLog();
  } catch (err) {
    // The continuity refusal (audit-unreadable): the entry is NOT written, and the caller's
    // `logged: null` makes the absence visible on the response. Named, not swallowed.
    console.error(`[audit] ${err.refused}: ${err.message}`);
    lastLogRefusal = { refused: err.refused, why: err.message };
    return null;
  }
  try {
    const dir = path.join(active.root.path, ".audit");
    mkdirSync(dir, { recursive: true });
    const file = auditPathFor(active.root);
    resumeLog();
    const entry = makeEntry(
      active.project,
      `machine:${active.root.path}`,
      INSTANCE,
      { name: "voicebox-server", harness: "voicebox", session: null, cwd: ROOT },
      act,
      decision,
      rule,
      result,
      observed,
      turn,
    );
    if (attempt !== null) entry.attempt = attempt;
    appendFileSync(file, `${serializeEntry(entry)}\n`);
    return entry;
  } catch {
    // A log that cannot be written must not take the act with it — but the act's outcome is then
    // reported without an entry, which the caller's `logged` field makes visible rather than silent.
    return null;
  }
}

/**
 * logAttempt — the record that trying happened, written BEFORE the act applies (y69). The
 * outcome entry carries `attempt` back to it; if no outcome ever arrives (a crash mid-act),
 * the next boot's sweep completes it as attempted-and-lost. Pre-flight REFUSALS do not get
 * attempts — they never entered the applying phase, and their refusal entry already names them.
 */
function logAttempt(act, turn = null) {
  if (!loggableRoot()) return null;
  try {
    const dir = path.join(active.root.path, ".audit");
    mkdirSync(dir, { recursive: true });
    const file = auditPathFor(active.root);
    resumeLog();
    const entry = makeEntry(
      active.project,
      `machine:${active.root.path}`,
      INSTANCE,
      { name: "voicebox-server", harness: "voicebox", session: null, cwd: ROOT },
      act,
      "attempt",
      "attempted",
      "pending",
      null,
    );
    entry.boot = BOOT;
    appendFileSync(file, `${serializeEntry(entry)}\n`);
    return entry;
  } catch {
    return null; // no attempt record must take the act down — the outcome entry still lands
  }
}

/** What the world says happened. The audit reads the world, never the caller's account. */
function observeUnderRoot(relPath) {
  try {
    const stat = statSync(path.join(active.root.path, relPath));
    return { exists: true, bytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return { exists: false };
  }
}
const PUBLIC = path.join(ROOT, "public");
mkdirSync(WORKSPACE, { recursive: true });

// WHICH TURN RESOLVER ANSWERS POST /api/turn. This is NOT the live provider — that is
// `VOICEBOX_LIVE_PROVIDER` (lib/live-session.mjs), a different concept that happens to share the word
// "provider". The old name `VOICEBOX_PROVIDER` is still honoured, out loud, because a shell that exports
// it must not break silently.
//
// WHY TWO NAMES BECAME NECESSARY rather than merely tidier: the pair read as though `LIVE_PROVIDER` were
// the live-mode sibling of `VOICEBOX_PROVIDER`, when one selects the TURN BRAIN and the other the LIVE
// TRANSPORT. It misled in practice, not only in theory — tests/lib/server.mjs records a voice-path
// developer exporting `VOICEBOX_PROVIDER=live`, which put "live" in the RESOLVER slot and stopped turns
// writing. Under this name that export is a visible category error instead of a silent one.
const legacyResolverEnv = process.env.VOICEBOX_PROVIDER;
if (legacyResolverEnv) {
  // ALWAYS SPEAKS WHEN THE OLD NAME IS SET — including when it is being ignored. A rename that silently
  // drops a variable an operator set is how a shell ends up configuring something that no longer exists,
  // and this line is the only place they can find out. (The test that caught the silent version is
  // tests/env-names.test.mjs: it sets both names and asserts the operator is told.)
  console.error(process.env.VOICEBOX_RESOLVER
    ? `[voicebox] VOICEBOX_PROVIDER is now VOICEBOX_RESOLVER (it selects the turn resolver, not the live provider) — IGNORING ${JSON.stringify(legacyResolverEnv)} because VOICEBOX_RESOLVER is set`
    : `[voicebox] VOICEBOX_PROVIDER is now VOICEBOX_RESOLVER (it selects the turn resolver, not the live provider) — honouring ${JSON.stringify(legacyResolverEnv)} for this release`);
}
const PROVIDER = process.env.VOICEBOX_RESOLVER ?? legacyResolverEnv ?? "script";

// ── the routed-acts channel (core/dispatch.ts) ──────────────────────────────
// The page is a PLACEMENT the server can ask to act. The channel is created once; the socket
// behind it is whichever environment page connected last. Its absence is never silent: the
// wire's own family answers (`no-page`, `page-timeout`, `page-closed`), so a turn against a
// page-owned root with no page open gets a named state and a remedy — "the page that owns
// this root is not open — open it and the turn will land" — never a hang.
let pageSocket = null;
const pageChannel = createChannel({
  peer: "page",
  environment: SELF_ENVIRONMENT,
  connected: () => pageSocket !== null,
  send: (s) => pageSocket?.send(s),
});
const pageExecutorConnected = () => pageSocket !== null;

/**
 * Revoke a pairing for the named environment key (voicebox-beads-yo1).
 * Immediately invalidates the credential in the store and terminates any
 * active connection (executor / live) currently operating under that authority.
 */
function revokePairing(envKey) {
  const read = readPairings();
  if (!read.ok) return read;
  const map = read.map;
  const entry = map[envKey];
  if (!entry) {
    return { ok: false, refused: "environment-not-paired", why: `no pairing exists for environment '${envKey}'` };
  }
  const oldAccept = entry.acceptBearer;
  entry.revoked = true;
  entry.revokedAt = new Date().toISOString();
  entry.revokedBy = "host-token";
  entry.revokedBearers = [
    ...(entry.revokedBearers ?? []),
    ...(oldAccept ? [oldAccept] : []),
  ];
  entry.acceptBearer = null;
  entry.callBearer = null;
  writePairings(map);

  // Terminate active connections operating under this environment:
  // 1. Executor channel:
  if (pageSocket && (pageSocket.envKey === envKey || (oldAccept && pageSocket.bearer === oldAccept))) {
    try {
      pageSocket.send(JSON.stringify({
        type: "refused",
        refused: "pairing-revoked",
        why: `the pairing for environment '${envKey}' was revoked by the host — executor authority terminated`,
      }));
      pageSocket.close(1008, "pairing-revoked");
    } catch {}
    pageSocket = null;
    pageChannel.abandon();
    console.error(`[channel] pairing revoked for '${envKey}' — executor socket closed and calls abandoned`);
  }

  // 2. Live session:
  if (runningSession && (runningSession.socket?.envKey === envKey || (oldAccept && runningSession.socket?.bearer === oldAccept))) {
    try {
      runningSession.socket.send(JSON.stringify({
        type: "refused",
        refused: "pairing-revoked",
        why: `the pairing for environment '${envKey}' was revoked by the host — live session terminated`,
      }));
      runningSession.socket.close(1008, "pairing-revoked");
    } catch {}
    runningSession = null;
    console.error(`[live] pairing revoked for '${envKey}' — live session closed`);
  }

  const audit = logAct({ kind: "pairing", target: envKey, tool: "pair" }, "allow", "pairing-revoked", "ok", null, null);
  return {
    ok: true,
    envKey,
    revoked: true,
    at: entry.revokedAt,
    logged: audit ? audit.seq : null,
    ...(audit ? {} : { logRefused: lastLogRefusal ?? "root-not-declared" }),
  };
}

// The extension system's tools act in the ACTIVE root, not a workspace of their own
// (voicebox-beads-gto): the host hands the declaration down live, and the page leg is the
// same dispatch a turn takes.
extensions.setHostHooks({
  activeRoot: () => active,
  actViaPage: (action) => executeViaPage(action),
});

// One ask, shaped the wire's way: attributed to the built-in file descriptor, carrying the
// ACTIVE root so the page can check the call is really for its project (root-not-mine), with
// containment RE-RUN page-side (core/dispatch.ts states the rule; browser/acts.ts enforces it).
function askPage(action) {
  return pageChannel.ask({
    tool: action.verb,
    descriptorId: CORE_FS_DESCRIPTOR,
    args: {
      root: active.root,
      name: String(action.name ?? ""),
      ...(action.content != null ? { content: String(action.content) } : {}),
      ...(action.turn != null ? { turn: String(action.turn) } : {}),
    },
    boundsEcho: {},
  });
}

/**
 * The page half of the dispatch: the machine cannot act on this root, so the page is asked.
 *
 * THE TRUST BOUNDARY (coord, 2026-09-20 — written here because a result is where it is read):
 * the server CANNOT verify a page-side act by reading the file itself. `observed` below is the
 * PAGE'S account of its own storage, and `via: "page"` is on every result so a reader can
 * always tell whose bytes a result quotes. The discipline around the account is the same as
 * the machine's — containment, named refusals, an audit entry read back from the world — and
 * the limit is stated in core/dispatch.ts and browser/acts.ts, not hidden.
 */
async function executeViaPage(action) {
  const answer = await askPage(action);
  if (!answer.ok) {
    // The missing audit entry is REPORTED, as on the machine path: no entry exists anywhere
    // (the page is the writer, and it never ran the act), and logRefused says why.
    return { ok: false, refused: answer.refused, error: `refused: ${answer.refused}`, why: answer.why, via: "page", root: active.root, logged: null, logRefused: answer.refused };
  }
  const observed = answer.observed ?? {};
  if (action.verb === "list") {
    return { ok: true, action: `listed ${active.project}`, files: observed.files ?? [], entries: observed.entries ?? [], via: "page", root: active.root };
  }
  if (action.verb === "read") {
    return { ok: true, action: observed.name ?? action.name, content: observed.content ?? "", via: "page", root: active.root, logged: observed.auditSeq ?? null };
  }
  // write — the action line carries the provenance, because this line is what the room prints.
  return {
    ok: true,
    action: `wrote ${observed.name ?? action.name} (${observed.bytes ?? 0} bytes) — observed by the page`,
    file: observed.name ?? action.name,
    via: "page",
    root: active.root,
    logged: observed.auditSeq ?? null,
    observed,
  };
}const PORT = Number(process.env.PORT ?? 8787);

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// WHICH REVISION IS THIS SERVER?
//
// 2026-09-19: Paul lost an hour to "the voice does not work with the API keys".
// The API server had been started at 19:19, before /live existed at 19:45, so
// it answered `{"error":"not found"}` — and the page's build stamp said
// `main @ fbaf0ca` the whole time, because it reported the PAGE's revision and
// nothing about the server's. Vite reloads the page on every edit; this process
// never does. So the server is the half that goes stale, and it is the half that
// was invisible. It now names itself, at startup, in its own health response.
const git = (args, fallback) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
};
const BUILD = (() => {
  const branch = git(["branch", "--show-current"], "(detached)");
  const remote = git(["rev-parse", "--short", `origin/${branch}`], "");
  return {
    branch,
    commit: git(["rev-parse", "--short", "HEAD"], "unknown"),
    remote: remote || null,
    ahead: remote ? Number(git(["rev-list", "--count", `origin/${branch}..HEAD`], "0")) : null,
    dirty: git(["status", "--porcelain", "--untracked-files=no"], "") !== "",
    startedAt: new Date().toISOString(),
  };
})();

// Normalising is not checking: `resolve` collapses `..`, then the answer is
// yes-or-no — is the candidate inside the workspace? (chrome-agent-platform-0j1a
// class: `basename("..")` is `".."`, so join+basename silently rewrote the
// escape instead of refusing it.)
function containedIn(baseDir, p) {
  const rel = path.relative(baseDir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function contained(p) {
  return containedIn(WORKSPACE, p);
}

/**
 * The machine placement's ADDITION to the shared containment: `core/paths.ts` is lexical, and a
 * lexical check follows a symlink out. So the lexical pass runs first (one implementation, refusing
 * `..` at any depth) and this pass resolves the real path — of the file if it exists, of its
 * directory if it does not — against the root's real path.
 */
function machineRootReal() {
  return realpathSync(active.root.path);
}

function machineContained(candidate) {
  const rootReal = machineRootReal();
  let probe = candidate;
  try {
    realpathSync(candidate);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    probe = path.dirname(candidate); // a write to a file that does not exist yet: check its directory
  }
  const real = realpathSync(probe);
  return containedIn(rootReal, real) || real === rootReal;
}

/**
 * Is the declared root still there? Asked BEFORE any filesystem access, because the filesystem is
 * where the hang came from: `realpathSync` on a deleted directory throws, and a throw inside an
 * unawaited async route callback leaves the caller waiting for a response that will never come.
 *
 * Only the machine kind can be checked from here — a page-owned root (OPFS, a picked handle) is
 * reachability's business, and that refusal already names who can act.
 */
function rootMissing() {
  if (!active) return noRootDeclared();
  if (active.root.kind !== "machine") return null;
  try {
    if (existsSync(active.root.path) && statSync(active.root.path).isDirectory()) return null;
  } catch {
    /* an unstattable root is a missing one */
  }
  return rootVanished(active.root.path);
}

/**
 * EVERY REQUEST GETS AN ANSWER. A route body that throws used to hang the caller: the async callback
 * was never awaited, so nothing wrote a response — measured, with the directory deleted under a live
 * declaration. The named refusal above is the product fix; this is the structural one, because a
 * server that answers "server-error" is wrong in a way a reader can act on and a server that says
 * nothing is not.
 */
function answerOnce(res, handler) {
  void (async () => {
    try {
      await handler();
    } catch (e) {
      console.error(`[route] ${e?.stack ?? e}`);
      try {
        if (!res.headersSent) json(res, 500, { ok: false, refused: "server-error", why: String(e?.message ?? e) });
        else res.end();
      } catch {
        /* the response is already gone */
      }
    }
  })();
}

/** Resolve a name through the seam, or the refusal that says why — used by every path below. */
function resolveActive(name) {
  if (!active) return { ...noRootDeclared() };
  const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
  if (!reach.ok) return { ok: false, refused: reach.refused, why: reach.why };
  const resolved = resolveInRoot(active.root, name);
  if (!resolved.ok) return { ok: false, refused: resolved.rule, why: resolved.why };
  if (!machineContained(resolved.path)) {
    return { ok: false, refused: "outside-root", why: `'${name}' resolves outside '${active.root.path}' by real path` };
  }
  if (protectedAuditPath(active.root.path, resolved.path)) {
    return { ok: false, refused: "protected-audit", why: "the audit is host-owned; task records require authenticated task_status, not a raw file read or write" };
  }
  return { ok: true, path: resolved.path };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".wat": "text/plain; charset=utf-8",
};

// Source served as source: the E1-M0 page imports core/ and browser/ directly, so the browser
// runs the SAME files the tests run and there is no build step and no second copy to drift from
// (N18, one level up). Node's own type-stripping is the transform — not a compiler, not a dep.
// lib: the page imports lib/channel.mjs through browser/acts.ts — same source-of-source rule as core/.
// The list lives in lib/browser-sources.mjs because the dev front must forward exactly these, and a
// second copy is how it drifted once already (voicebox-beads-geq).

function serveSource(res, url) {
  const rel = url.pathname.replace(/^\/+/, "");
  const dir = rel.split("/")[0];
  const file = path.resolve(ROOT, rel);
  const allowed = path.join(ROOT, dir) + path.sep;
  if (!SOURCE_DIRS.has(dir) || !file.startsWith(allowed) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  const ext = path.extname(file);
  const type = MIME_TYPES[ext];
  if (!type) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }
  const body = ext === ".ts"
    ? stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" })
    : readFileSync(file);
  res.writeHead(200, { "content-type": type });
  res.end(body);
}

// Resolves a request path under PUBLIC, preserving subdirectories (e.g. /fonts/...)
// while strictly enforcing that the target cannot escape PUBLIC (no .. or symlink escapes).
function resolvePublicFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = path.resolve(PUBLIC, "." + decoded);
  if (!containedIn(PUBLIC, candidate)) return null;
  try {
    const real = realpathSync(candidate);
    if (!containedIn(PUBLIC, real)) return null;
    return real;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// The executor: the one place that touches the build environment. It grows;
// the resolver stays the same shape.
async function execute(action) {
  // make-tool: the model's authoring act (N10). It PROPOSES — a tier 1 write
  // into workspace/proposals/ — and nothing else. Registration is the host's
  // route (POST /api/extensions/admit), which the model does not reach.
  if (action.verb === "make-tool") {
    const r = extensions.propose(action.tool, "model");
    if (!r.ok) return r;
    return { ok: true, action: `proposed tool '${r.id}'`, state: r.state, note: "the proposal is NOT loaded — the host reviews and admits it (GET /api/extensions/proposals/<id>/plan, then POST /api/extensions/admit)" };
  }
  // tool: the ONLY way a tool runs — and only ADMITTED tools are here.
  if (action.verb === "tool") {
    return callTool(action.name, action.args ?? {});
  }
  // `logged` is present as null rather than absent: "there is no entry" must be a fact on the
  // response, not something a reader has to notice the absence of.
  if (!active) return { ...noRootDeclared(), error: `refused: ${ROOT_NOT_DECLARED}`, root: null, logged: null };
  const vanished = rootMissing();
  if (vanished) return { ...vanished, error: `refused: ${vanished.refused}`, root: active.root, logged: null };
  // THE ROUTER (core/dispatch.ts): who acts on this root? `machine` falls through to the
  // unchanged local path below; `page` asks the connected environment page; the refusal
  // survives only when neither can act. ONE decision, one place — the REST turn path here,
  // and the live tool-call path when it lands, call the same executor.
  const dispatch = dispatchFor(active.root, SELF_ENVIRONMENT);
  if (dispatch.refuse) return { ok: false, refused: dispatch.refuse.refused, error: `refused: ${dispatch.refuse.refused}`, why: dispatch.refuse.why, root: active.root, logged: null };
  if (dispatch.executeOn === "page") return executeViaPage(action);
  if (action.verb === "list") {
    const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
    if (!reach.ok) return { ok: false, refused: reach.refused, error: `refused: ${reach.refused}`, why: reach.why, root: active.root };
    return { ok: true, action: `listed ${active.project}`, files: readdirSync(active.root.path).filter((f) => !f.startsWith(".")), root: active.root };
  }
  const name = String(action.name ?? "");
  if (!name) return { ok: false, error: "action has no name" };
  const resolved = resolveActive(name);
  if (!resolved.ok) {
    // A refusal is recorded as well: the log answers "what did it try", not only "what did it do".
    const kind = action.verb === "read" ? "read" : "write";
    const entry = logAct({ kind, target: name, tool: "turn" }, "refuse", resolved.refused, "refused", null, action.turn ?? null);
    return {
      ok: false,
      refused: resolved.refused,
      logged: entry ? entry.seq : null,
      ...(entry ? {} : { logRefused: resolved.refused === "root-not-reachable-from-here" ? "root-not-reachable-from-here" : "log-not-written" }),
      error: `refused: ${resolved.refused === "outside-root" ? "path escapes the active project root" : resolved.refused}`,
      why: resolved.why,
      root: active.root,
      logged: entry ? entry.seq : null,
    };
  }
  // Dotfiles are behind the same line as the listing: containment first (so `..` and
  // traversal keep their own, stronger refusal), then a hidden file inside the root is
  // refused — otherwise a declared root pointed at a sensitive directory (the host's
  // own extensions dir) hands over its secrets — including the admission token —
  // through a read, or loses them to a write over it. Driven chain, 2026-09-20:
  // declare -> read .host-token -> admit.
  if (action.verb === "read" || action.verb === "write") {
    const base = path.basename(resolved.path);
    if (base.startsWith(".")) {
      const entry = logAct({ kind: action.verb === "write" ? "write" : "read", target: name, tool: "turn" }, "refuse", "dotfile-refused", "refused", null, action.turn ?? null);
      return { ok: false, refused: "dotfile-refused", logged: entry ? entry.seq : null, error: "refused: dotfile-refused", why: "dotfiles are neither readable nor writable through the loop — the listing hides them and so does this verb; host secrets live behind that line", root: active.root };
    }
  }
  const candidate = resolved.path;
  if (action.verb === "write") {
    // THE WORST OUTCOME THIS SYSTEM CAN PRODUCE, refused here: a write with ABSENT content
    // used to fall into `?? ""` — the existing file was EMPTIED and the result said ok:true,
    // so nothing downstream could tell the data was gone (astra's live-tools review,
    // 2026-09-20; shared by the text path, so it is fixed at the shared validation).
    // Absent ≠ empty: `content: ""` is an intentional empty file and writes fine; a MISSING
    // argument is a malformed act, refused by name, and the file on disk is UNTOUCHED.
    if (action.content == null) {
      const entry = logAct({ kind: "write", target: name, tool: "turn" }, "refuse", "missing-content", "refused", null, action.turn ?? null);
      return {
        ok: false,
        refused: "missing-content",
        logged: entry ? entry.seq : null,
        error: "refused: missing-content",
        why: `the write to '${name}' carried no content — pass content explicitly (an empty string is a valid, intentional empty file). The existing file was NOT touched.`,
        root: active.root,
      };
    }
    // ATTEMPT-FIRST (voicebox-beads-y69): past pre-flight, the trying is recorded BEFORE the
    // applying — so a crash between here and the outcome leaves a dangling attempt that the
    // next boot names "lost", instead of the act silently never having existed.
    const att = logAttempt({ kind: "write", target: name, tool: "turn" }, action.turn ?? null);
    let entry;
    try {
      writeFileSync(candidate, action.content);
    } catch (err) {
      entry = logAct({ kind: "write", target: name, tool: "turn" }, "refuse", "write-error", "error", null, action.turn ?? null, att?.seq ?? null);
      return {
        ok: false,
        refused: "write-error",
        why: `the write failed while applying: ${err?.message ?? err}`,
        logged: entry ? entry.seq : null,
        attempt: att?.seq ?? null,
        root: active.root,
      };
    }
    entry = logAct({ kind: "write", target: name, tool: "turn" }, "allow", "writes-inside", "ok", observeUnderRoot(name), action.turn ?? null, att?.seq ?? null);
    return {
      ok: true,
      action: `wrote ${name} (${action.content.length} bytes)`,
      file: name,
      root: active.root,
      logged: entry ? entry.seq : null,
      ...(entry ? {} : lastLogRefusal ? { logRefused: lastLogRefusal.refused, logWhy: lastLogRefusal.why } : {}),
      attempt: att?.seq ?? null,
      auditLocation: `${active.root.path}/.audit/`,
    };
  }
  if (action.verb === "read") {
    let content;
    try {
      content = readFileSync(candidate, "utf8");
    } catch (e) {
      // A missing file is a NAMED REFUSAL, not a throw into the route — a throw in a batch
      // (the live tool-call path) used to swallow every sibling's response with it.
      if (e.code === "ENOENT") {
        const entry = logAct({ kind: "read", target: name, tool: "turn" }, "refuse", "not-found", "refused", null, action.turn ?? null);
        return { ok: false, refused: "not-found", logged: entry ? entry.seq : null, error: "refused: not-found", why: `'${name}' is not in ${active.project}`, root: active.root };
      }
      throw e;
    }
    const entry = logAct({ kind: "read", target: name, tool: "turn" }, "allow", "reads-inside", "ok", observeUnderRoot(name), action.turn ?? null, [{ path: name, bytes: Buffer.byteLength(content) }]);
    return { ok: true, action: name, content, root: active.root, logged: entry ? entry.seq : null };
  }
  return { ok: false, error: `unknown verb: ${action.verb}` };
}

/**
 * requested · applied · pending — computed, not stored, so it cannot go stale.
 *
 * `applied` reads the live path (the resolved provider and its model) and reports `null` for the two
 * settings no session reads yet, with the reason. Making `voice` or `personality` say "applied" before
 * a provider carries them would be the exact lie this payload exists to prevent.
 */
function agentSettingsPayload(extra = {}) {
  const provider = PROVIDERS[agentSettings.provider];
  const keyPresent = Boolean(process.env[provider.requires.env]);
  const capabilities = Object.values(PROVIDERS).map((facts) => ({
    id: facts.id,
    label: facts.label,
    model: facts.model,
    voices: facts.voices,
    available: Boolean(process.env[facts.requires.env]),
    ...(process.env[facts.requires.env] ? {} : { refused: "provider-not-configured", why: `${facts.requires.env} is not set — ${facts.requires.why}` }),
  }));

  return {
    ok: true,
    requested: agentSettings,
    applied: {
      // What the NEXT session will use (the setting is passed to createLiveSession, so this is a fact
      // rather than a promise), and `running` says what a live session started with — a person asking
      // "did my change take effect?" is usually asking about that second one.
      provider: agentSettings.provider,
      model: provider.model,
      // Carried into the session's setup since the settings handoff landed: the voice in the
      // provider's own field, the composed instruction as the session's system instruction.
      voice: agentSettings.voice || `${provider.label}'s default`,
      instruction: agentSettings.personality,
    },
    pending: {
      // Nothing is pending any more: every setting the surface offers is carried into the session.
      // The keys stay (null) so a reader can tell "nothing pending" from "the field is gone".
      voice: provider.voices.length ? null : "this provider offers no voices",
      personality: null,
    },
    base: {
      // The mandatory half, shown so a person can see what a personality is layered ON. Read-only by
      // construction: nothing here accepts a base instruction.
      instruction: AGENT_BASE_INSTRUCTION,
      editable: false,
      note: "personality appends a tone layer beneath these rules; it cannot replace them",
    },
    personalities: Object.values(PERSONALITIES).map((p) => ({ id: p.id, label: p.label })),
    // Which providers a person may choose AT ALL, and the ones that cannot run say why — the rule that
    // stops an option being offered that fails the moment it is chosen.
    capabilities,
    runningSession,
    providerAvailable: keyPresent,
    ...(keyPresent ? {} : { refused: "provider-not-configured", why: `${provider.requires.env} is not set — ${provider.requires.why}` }),
    persisted: "memory (until this process restarts)",
    ...extra,
  };
}

const routes = {
  // THE AGENT'S SETTINGS, and the distinction this whole surface exists to keep:
  //   requested — what a person asked for, stored whether or not anything can use it yet
  //   applied   — what the RUNNING session can be shown to use, never what was asked for
  //   pending   — for each setting that is stored but not yet read by a session, WHY
  // A setting that silently does nothing is worse than no setting, so the gap is in the payload.
  "GET /api/agent-settings": (req, res, url) => json(res, 200, agentSettingsPayload()),
  "PUT /api/agent-settings": (req, res, url) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let asked;
      try {
        asked = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON: {provider?, voice?, personality?}" });
      }
      const checked = validateAgentSettings(asked, agentSettings);
      if (!checked.ok) return json(res, 400, { ok: false, refused: checked.refused, why: checked.why });
      // Changing the provider does NOT start a session: the next one this page opens will use it, and
      // the payload says the live session is untouched rather than implying the change took effect now.
      agentSettings = checked.value;
      // THE NOTE HAS TO MATCH THE STATE, not the common case. It used to say "a session already running
      // keeps the provider it started with" to everybody, including a person with no session — a change
      // deferred to nothing. Now it says which of the two is true.
      return json(res, 200, agentSettingsPayload({
        note: runningSession
          ? "stored — the live session already running keeps the provider it started with"
          : "stored — no live session is running, so the next one this page opens will use it",
      }));
    }));
    return;
  },

  // UN-DECLARE: back to `root-not-declared`, deliberately and by request. The gate asserts that
  // state positively, and a state you cannot return to is one you can only test once per process —
  // and for a person, "close the project" has to have an expression that is not "restart the server".
  //
  // ORDERING LESSON, kept where the next person will read it: the harness that found the vanished-root
  // hang deleted its scratch directory BEFORE restoring the previous root, and left the live server
  // holding a declaration pointing at nothing. RESTORE THE PREVIOUS STATE FIRST, then remove your own.
  "DELETE /api/root": (req, res, url) => {
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, {
        ok: false,
        refused: "host-token-required",
        why: "un-declaring is the host's act too: it cannot point the loop at a new directory, but it can break a project that is mid-write, so it takes the same token (x-voicebox-host-token)",
      });
    }
    const previous = active;
    active = null;
    return json(res, 200, {
      ok: true,
      declared: false,
      unDeclared: previous ? { project: previous.project, root: previous.root } : null,
      refused: ROOT_NOT_DECLARED,
      why: noRootDeclared().why,
    });
  },
  "GET /api/health": (req, res, url) => json(res, 200, {
    ok: true,
      // `created` is the count the live-auth tests assert on: a refusal that still created a session is
      // the defect this number exists to catch (a refusal is not proof that nothing was spent).
      live: { created: liveSessionsCreated, running: Boolean(runningSession) },
    provider: PROVIDER,
    // There is no default root to report; `declared` says whether one exists at all.
    declared: Boolean(active),
    root: active ? active.root : null,
    project: active ? active.project : null,
    refused: active ? null : ROOT_NOT_DECLARED,
    why: active ? null : noRootDeclared().why,
    build: BUILD,
  }),
  // THE SEAM, read side: which root is the loop writing into, and may this process act on it?
  "GET /api/root": (req, res, url) => {
    if (!active) {
      const absent = noRootDeclared();
      return json(res, 200, { ok: true, declared: false, project: null, root: null, reachableFromThisProcess: false, executor: { page: "environment", connected: pageExecutorConnected() }, ...absent });
    }
    const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
    return json(res, 200, {
      ok: true,
      declared: true,
      project: active.project,
      root: active.root,
      facts: ROOT_FACTS[active.root.kind],
      description: describeRoot(active.root),
      reachableFromThisProcess: reach.ok,
      refused: reach.ok ? null : reach.refused,
      why: reach.ok ? null : reach.why,
      // Who performs the act (core/dispatch.ts) — and whether that someone is here right now.
      // The room keys its honesty off these two fields (voicebox-ui, 2026-09-20).
      actsVia: dispatchFor(active.root, SELF_ENVIRONMENT).executeOn === "page" ? "page" : "server",
      executor: { page: "environment", connected: pageExecutorConnected() },
      declaredAt: active.declaredAt,
    });
  },
  "GET /": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(path.join(PUBLIC, "index.html")));
  },
  "GET /index.html": (req, res, url) => routes["GET /"](req, res, url),
  "GET /fused.js": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(path.join(PUBLIC, "fused.js")));
  },
  "GET /styles.css": (req, res, url) => {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(readFileSync(path.join(PUBLIC, "styles.css")));
  },
  // Static fallthrough: anything else the page asks for that lives in public/.
  // Preserves subdirectories (e.g. /fonts/x.woff2) with traversal guards.
  "GET /static": (req, res, url) => {
    const file = resolvePublicFile(url.pathname);
    if (!file || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    const type = MIME_TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(file));
  },
};

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  // Fall through to public/ for any other path the page requests.
  if (req.method === "GET" && !routes[key] && !url.pathname.startsWith("/api/")) {
    const file = resolvePublicFile(url.pathname);
    if (file && existsSync(file)) {
      try {
        if (statSync(file).isFile()) {
          const type = MIME_TYPES[path.extname(file)] ?? "application/octet-stream";
          res.writeHead(200, { "content-type": type });
          return res.end(readFileSync(file));
        }
      } catch {}
    }
  }
  const route = routes[key];
  if (route) return route(req, res, url);

  if (req.method === "GET" && SOURCE_DIRS.has((url.pathname.split("/")[1] ?? ""))) {
    return serveSource(res, url);
  }

  // THE SEAM, declare side: the environment says which project is active and what kind of root it
  // has. A machine root is validated here (it is this process's own filesystem); the other two kinds
  // are RECORDED as the active project and reported as unreachable from here — accepted, because the
  // environment owning them is a fact, and refused, because this process must not pretend to act on
  // them. That is the whole difference between one root and two.
  if (req.method === "POST" && url.pathname === "/api/root") {
    // DECLARING THE ROOT IS THE HOST'S ACT. Same authority class as admitting an extension or issuing
    // a pairing bearer, and the same mechanism as both (voicebox-beads-m2i): a host-generated secret,
    // mode 0600, in the host's own directory, served by no route — the person's shell has it.
    //
    // This route is the remaining hole of that shape: it re-points every file route, so without the
    // token anything that can reach the server can aim the loop at anything the process can read.
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, {
        ok: false,
        refused: "host-token-required",
        why: "declaring the project root is the host's act — it re-points every file route — and this route requires the host token (x-voicebox-host-token); the page cannot hold it",
      });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let declared;
      try {
        declared = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON: {project, root}" });
      }
      const project = String(declared?.project ?? "").trim();
      const root = declared?.root;
      if (!project || !root || typeof root !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "a declaration needs a project name and a root descriptor" });
      }
      if (!Object.prototype.hasOwnProperty.call(ROOT_FACTS, root.kind)) {
        return json(res, 400, { ok: false, refused: "unknown-root-kind", why: `'${root.kind}' is not a root kind this seam knows (${Object.keys(ROOT_FACTS).join(", ")})` });
      }

      if (root.kind === "machine") {
        const requested = String(root.path ?? "");
        if (!requested.trim()) {
          return json(res, 400, { ok: false, refused: "bad-request", why: "a machine root needs a path" });
        }
        const candidate = path.resolve(requested);
        if (!existsSync(candidate)) {
          return json(res, 404, { ok: false, refused: "path-missing", why: `'${requested}' does not exist on this machine` });
        }
        let real;
        try {
          real = realpathSync(candidate);
        } catch (e) {
          return json(res, 400, { ok: false, refused: "not-a-directory", why: `'${requested}' could not be resolved: ${e.code}` });
        }
        if (!statSync(real).isDirectory()) {
          return json(res, 400, { ok: false, refused: "not-a-directory", why: `'${requested}' is a file; a project root is a folder` });
        }
        active = { project, root: { kind: "machine", path: real, environment: SELF_ENVIRONMENT }, declaredAt: new Date().toISOString() };
        return json(res, 200, {
          ok: true,
          project: active.project,
          root: active.root,
          canonical: real !== candidate,
          facts: ROOT_FACTS.machine,
          description: describeRoot(active.root),
          reachableFromThisProcess: true,
          actsVia: "server",
          executor: { page: "environment", connected: pageExecutorConnected() },
          declaredAt: active.declaredAt,
        });
      }

      // opfs | handle: the page's roots. Recorded as the active project; the machine cannot
      // act on them directly, and since core/dispatch.ts the act ROUTES to the page — the
      // response says so, and whether the page that owns them is connected right now.
      active = { project, root: { kind: root.kind, environment: SELF_ENVIRONMENT, ...(root.path ? { path: String(root.path) } : {}), ...(root.id ? { id: String(root.id) } : {}) }, declaredAt: new Date().toISOString() };
      const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
      return json(res, 200, {
        ok: true,
        project: active.project,
        root: active.root,
        facts: ROOT_FACTS[active.root.kind],
        description: describeRoot(active.root),
        reachableFromThisProcess: false,
        refused: reach.refused,
        why: reach.why,
        actsVia: "page",
        executor: { page: "environment", connected: pageExecutorConnected() },
        declaredAt: active.declaredAt,
      });
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    // The root's log, read by whoever can reach the root — the same read the environment does in its
    // own placement, so "what did it do here" has one answer per root rather than one per placement.
    if (!active) return json(res, 200, { ...noRootDeclared(), root: null, entries: [] });
    const vanished = rootMissing();
    if (vanished) return json(res, 200, { ...vanished, root: active.root, entries: [] });
    const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
    if (!reach.ok) return json(res, 200, { ok: false, refused: reach.refused, why: reach.why, root: active.root, entries: [] });
    const dir = path.join(active.root.path, ".audit");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    const entries = files.flatMap((f) =>
      readFileSync(path.join(dir, f), "utf8").split("\n").map(parseEntry).filter(Boolean),
    );
    return json(res, 200, { ok: true, root: active.root, instance: INSTANCE, files, entries: mergeAudit(entries.filter((entry) => entry.kind !== "task")) });
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    // The listing follows the ACTIVE root: a listing from a root the loop cannot reach would be the
    // two-root bug in miniature — a panel showing files from somewhere the project is not.
    if (!active) return json(res, 200, { ...noRootDeclared(), root: null, files: [], entries: [] });
    const vanishedFiles = rootMissing();
    if (vanishedFiles) return json(res, 200, { ...vanishedFiles, root: active.root, files: [], entries: [] });
    // A page-owned root lists through the page (core/dispatch.ts): the room sees the same
    // files whichever root kind the project is on, and the answer says whose listing it is.
    if (dispatchFor(active.root, SELF_ENVIRONMENT).executeOn === "page") {
      const answer = await askPage({ verb: "list", name: "" });
      if (!answer.ok) return json(res, 200, { ok: false, refused: answer.refused, why: answer.why, via: "page", root: active.root, files: [], entries: [] });
      const observed = answer.observed ?? {};
      return json(res, 200, { ok: true, via: "page", root: active.root, project: active.project, files: observed.files ?? [], entries: observed.entries ?? [] });
    }
    const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
    if (!reach.ok) {
      return json(res, 200, { ok: false, refused: reach.refused, why: reach.why, root: active.root, files: [], entries: [] });
    }
    const dir = active.root.path;
    const fileNames = readdirSync(dir).filter(f => !f.startsWith("."));
    const entries = fileNames.map(name => {
      try {
        const full = path.join(dir, name);
        const stat = statSync(full);
        return { name, bytes: stat.size, kind: stat.isDirectory() ? "directory" : "file" };
      } catch {
        return { name, bytes: 0, kind: "file" };
      }
    });
    return json(res, 200, { ok: true, root: active.root, project: active.project, files: fileNames, entries });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const name = url.searchParams.get("name") ?? "";
    if (!name) return json(res, 400, { error: "action has no name" });
    if (!active) return json(res, 409, { ...noRootDeclared() });
    const vanishedRead = rootMissing();
    if (vanishedRead) return json(res, 409, { ...vanishedRead, root: active.root });
    // A page-owned root reads through the page (core/dispatch.ts) — the room's reader works
    // for a picked folder exactly as for a machine folder, and says whose bytes it shows.
    if (dispatchFor(active.root, SELF_ENVIRONMENT).executeOn === "page") {
      const answer = await askPage({ verb: "read", name });
      if (!answer.ok) {
        return json(res, answer.refused === "not-found" ? 404 : 409, { ok: false, refused: answer.refused, error: `refused: ${answer.refused}`, why: answer.why, via: "page", root: active.root });
      }
      const observed = answer.observed ?? {};
      return json(res, 200, { ok: true, via: "page", name, content: observed.content ?? "", bytes: observed.bytes ?? 0 });
    }
    const resolved = resolveActive(name);
    if (!resolved.ok) {
      return json(res, resolved.refused === "root-not-reachable-from-here" ? 409 : 403, {
        refused: resolved.refused,
        error: `refused: ${resolved.refused}`,
        why: resolved.why,
        root: active.root,
      });
    }
    try {
      const real = resolved.path;
      if (path.basename(real).startsWith(".")) {
        // Same line as the verbs: containment first, then a hidden file inside the
        // root is refused — the listing hides it, so the read does too.
        return json(res, 403, { ok: false, refused: "dotfile-refused", error: "refused: dotfile-refused", why: "dotfiles are not readable through the loop — the listing hides them and so does this read; host secrets live behind that line", root: active.root });
      }
      const stat = statSync(real);
      if (stat.isDirectory()) return json(res, 400, { error: "cannot read directory" });
      const content = readFileSync(real, "utf8");
      return json(res, 200, { ok: true, name, content, bytes: stat.size });
    } catch (e) {
      if (e.code === "ENOENT") return json(res, 404, { error: "file not found" });
      // A READ THAT FAILS FOR ANY OTHER REASON IS NAMED TOO. This used to fall through to the generic
      // 500 ("internal error — the turn was not executed"), which is both unhelpful and untrue about a
      // file read, and the sentence a person saw was about turns. Found by asking the question of the
      // reader's failure line from the other side: the `where` had been fixed, and the `why` had not.
      const code = e?.code ?? "error";
      // THE LABEL AND THE REASON, both — which is safe because the PAGE prefers `why`
      // (`reasonFrom` in public/fused.js: why, then error, then note). Before that rule existed I had to
      // drop `error` here, because the reader showed `error` first and a short label shadowed the
      // platform's sentence; now every refusal in this route carries the same three facts — `refused`,
      // `error` as the label, `why` as the sentence — and the page chooses the useful one.
      //
      // The platform's words already begin with the code — prefixing it again produced
      // "EACCES: EACCES: permission denied…", so `why` is used exactly as it arrives.
      return json(res, code === "EACCES" || code === "EPERM" ? 403 : 500, {
        ok: false,
        refused: "unreadable",
        error: `refused: unreadable (${code})`,
        why: e?.message ?? String(e),
        path: resolved.path,
        root: active.root,
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/environments") {
    // The list, with each host's reachability probed NOW and its STORED capability report merged in.
    // An unreadable registry is the named refusal, not an empty list.
    const result = await environmentsWithStatus();
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, { ok: true, environments: result.environments });
  }

  /**
   * **`GET /api/probe` — this environment probes ITSELF and says what it found.**
   *
   * Paul (2026-09-20): the probe runs AUTOMATICALLY (not a button), and because it runs code inside
   * the environment unprompted, THE ACT IS RECORDED — an `activity` entry in the environment's own
   * audit, so the first time something runs somewhere unasked, the system can say it did. The report
   * is OBSERVED (the probe runs and reads), never a manifest, and it is cached with its `when` so a
   * stale one reads as stale. A probe that cannot run is a named refusal, not a blank.
   */
  if (req.method === "GET" && url.pathname === "/api/probe") {
    const cached = readProbeCache();
    if (cached) return json(res, 200, { ok: true, probe: cached, cached: true });
    try {
      const report = await runProbe();
      writeProbeCache(report);
      recordProbeAct(report);
      return json(res, 200, { ok: true, probe: report, cached: false });
    } catch (err) {
      return json(res, 500, { ok: false, refused: "probe-failed", why: `the environment could not probe itself — ${(err?.message ?? err)}` });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/environments") {
    // The "+" button: declare an environment. It is written to the list, NOT started — a declared
    // host that is not running will say so by name the next time the list is read. The server
    // generates the key; the person supplies the label and the origin.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON: {label, kind, origin, home?}" });
      }
      const candidate = parseEnvironment({ ...parsed, key: `env_${randomBytes(8).toString("hex")}` });
      if (!candidate.ok) return json(res, 400, candidate);
      const stored = readEnvironments();
      if (!stored.ok) return json(res, 500, stored);

      // **Declare-and-boot a fence.** `fence: true` asks the host to BOOT an L1 bwrap fence for this
      // descriptor rather than only recording it — the prototype productized. The boundary the row
      // carries is the fence's OWN probe report (host-collected at boot), which is the one writer the
      // read path trusts — so a measured boundary survives where a hand-written claim would be nulled.
      if (parsed.fence === true) {
        const booted = await bootFence(candidate.value);
        if (!booted.ok) return json(res, 502, { ok: false, refused: booted.refused, why: booted.why });
        const descriptor = {
          ...candidate.value,
          origin: booted.origin,
          home: booted.home,
          boundary: booted.boundary,     // the measured report — the probe is its writer
          capability: booted.capability,
          declaredAt: new Date().toISOString(),
        };
        writeEnvironments([...stored.environments, descriptor]);
        return json(res, 200, { ok: true, environment: descriptor, booted: true });
      }

      const descriptor = { ...candidate.value, declaredAt: new Date().toISOString() };
      writeEnvironments([...stored.environments, descriptor]);
      return json(res, 200, { ok: true, environment: descriptor });
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let transcript = "";
      try {
        transcript = String(JSON.parse(body).transcript ?? "").trim();
      } catch {
        return json(res, 400, { error: "body must be JSON with a transcript" });
      }
      if (!transcript) return json(res, 400, { error: "empty transcript" });
      const action = await resolveTurn(transcript, PROVIDER);
      if (action.unresolved) {
        return json(res, 200, { transcript, action: null, note: action.unresolved });
      }
      return json(res, 200, { transcript, action, result: await execute(action) });
    }));
    return;
  }

  // ── the extension surface (N17): discover, inventory, sideload ──────────
  // The disclosure sits between the verbs: every confirm-first act returns
  // the RESOLVED PLAN — the extension's source, what it declares, what will
  // be enforced and by which mechanism, what it cannot have — before the act
  // runs. The page (astra's bead) renders this; the API is the surface.
  const readJson = (maxBytes = Infinity) => new Promise((resolve) => {
    let body = "", bytes = 0;
    req.on("data", (c) => { bytes += c.length; if (bytes <= maxBytes) body += c; });
    req.on("end", () => { try { resolve(bytes > maxBytes ? null : JSON.parse(body || "{}")); } catch { resolve(null); } });
  });

  if (req.method === "GET" && url.pathname === "/api/extensions") {
    return json(res, 200, extensions.inventory());
  }
  if (req.method === "GET" && url.pathname === "/api/extensions/catalogue") {
    return json(res, 200, { catalogue: extensions.catalogue() });
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/proposals") {
    // The model's door over HTTP (what a model resolver calls): the same
    // destination as the transcript path — a PENDING proposal, nothing loaded.
    const body = await readJson();
    const r = extensions.propose(body?.descriptor, body?.descriptor?.source ?? "model");
    return r.ok ? json(res, 200, { ...r, note: "staged as a pending proposal — NOT loaded; the host admits it" }) : json(res, 400, r);
  }
  const planMatch = url.pathname.match(/^\/api\/extensions\/(proposals|catalogue)\/([a-z0-9_-]+)\/plan$/);
  if (req.method === "GET" && planMatch) {
    const plan = planMatch[1] === "proposals" ? extensions.proposalPlan(planMatch[2]) : extensions.cataloguePlan(planMatch[2]);
    return plan ? json(res, 200, plan) : json(res, 404, { error: `no ${planMatch[1].replace(/s$/, "")} '${planMatch[2]}'` });
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/sideload") {
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    const plan = extensions.cataloguePlan(body.id);
    if (!plan) return json(res, 404, { error: `no catalogue entry '${body.id}'` });
    if (body.confirm !== true) {
      // Confirm-first: show the plan, stage nothing.
      return json(res, 200, { confirmFirst: true, plan, note: "nothing staged — repeat with confirm:true to stage the sideload as a PENDING proposal (it does not load; admission is still the host's)" });
    }
    const r = extensions.sideload(body.id);
    return r.ok ? json(res, 200, { ...r, note: "staged as a pending proposal — NOT loaded; the host admits it" }) : json(res, 400, r);
  }
  if (req.method === "POST" && ["/api/extensions/approval-request", "/api/extensions/approve"].includes(url.pathname)) {
    // JSON-only stops cross-site form submissions; no CORS permission is granted. The console
    // code, not an Origin claim or page-held host credential, authorizes this specific plan.
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      return json(res, 415, { ok: false, refused: "approval-json-required", why: "Send the approval request as JSON." });
    }
    const body = await readJson(4096);
    if (typeof body?.id !== "string" || !/^[a-z0-9_-]{1,100}$/.test(body.id)) {
      return json(res, 400, { ok: false, refused: "approval-invalid-id", why: "Choose an extension from the review list." });
    }
    const r = url.pathname.endsWith("/approval-request")
      ? extensions.requestApproval(body.id)
      : extensions.approveWithCode(body.id, body.requestId, body.code);
    return json(res, r.ok ? 200 : 403, r);
  }
  if (req.method === "POST" && url.pathname === "/api/extensions/admit") {
    // Admission is the HOST's act (bead voicebox-beads-m2i): the route requires
    // the host token (docs/02 §1.5's mechanism — a 0600 file in the host's own
    // directory, readable by the person's shell, by neither the page nor the
    // model). Driven finding, 2026-09-20: without this the page admitted its
    // own proposal in two fetches. The refusal is named, like every other one.
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "admission is the host's act — this route requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    const plan = extensions.proposalPlan(body.id);
    if (!plan) return json(res, 404, { error: `no proposal '${body.id}'` });
    if (body.confirm !== true) {
      // Confirm-first: the Tier 2 review act whose resolved plan is the source.
      return json(res, 200, { confirmFirst: true, plan, note: "nothing decided — repeat with confirm:true and decision 'admit'|'deny' to decide" });
    }
    const r = extensions.admitProposal(body.id, body.decision === "deny" ? "deny" : "admit");
    return json(res, 200, r);
  }

  if (req.method === "GET" && url.pathname === "/api/permissions/pending") {
    return json(res, 200, { ok: true, pending: permissions.pending() });
  }

  if (req.method === "POST" && url.pathname === "/api/permissions/resolve") {
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "resolving a permission request requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson().catch(() => ({}));
    const requestId = typeof body?.requestId === "string" ? body.requestId : null;
    if (!requestId) return json(res, 400, { ok: false, refused: "bad-request", why: "resolving a permission request names the requestId" });
    const result = permissions.resolve(requestId, {
      allow: Boolean(body.allow),
      optionId: typeof body.optionId === "string" ? body.optionId : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return json(res, result.ok ? 200 : 409, result);
  }
  // ── PAIRING + PROXIED CALL (docs/09-proxied-custody.md; journal-wdq decisions 3+4) ─────────────
  // Custody: the page holds NO remote credential. It names an environment by KEY and the local host
  // originates the call, attaching the bearer it holds. Pairing is the explicit act that creates the
  // bearer on BOTH sides (0600, outside any project root, served by no route). A call to an unpaired
  // or unreachable environment is refused BY NAME. THE DRIVEN CASE IS THE REMOTE ONE — two real
  // servers — because local success is what hid the firewall failure all evening.
  if (req.method === "POST" && url.pathname === "/api/pair") {
    // The REMOTE side: accept a pairing request and issue a bearer bound to THIS environment's key.
    // PAIRING CREATES A CREDENTIAL — the same authority class as admission, so the same gate: the
    // host token. The token is checked, never logged, and never echoed in a refusal's `why`.
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "pairing creates a credential — it is the host's act and requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson();
    const envKey = body?.envKey;
    if (typeof envKey !== "string" || !envKey) {
      return json(res, 400, { ok: false, refused: "bad-request", why: "pairing names the environment key it asks to pair with" });
    }
    const bearer = `vbx_${randomBytes(24).toString("hex")}`;
    storeBearer(envKey, bearer); // this host's side: the bearer it will accept
    return json(res, 200, { ok: true, envKey, bearer });
  }

  if (req.method === "POST" && url.pathname === "/api/pair/complete") {
    // The LOCAL side of pairing: the person confirmed, the remote issued a bearer, and this host
    // records the bearer it will use when calling that environment. The page is never given it —
    // and this act is gated too, because it registers a credential on the host.
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "pairing creates a credential — it is the host's act and requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson();
    const envKey = typeof body?.envKey === "string" ? body.envKey : null;
    const bearer = typeof body?.bearer === "string" ? body.bearer : null;
    if (!envKey || !bearer) return json(res, 400, { ok: false, refused: "bad-request", why: "pairing completion carries the environment key and the bearer it issued" });
    const target = await resolveEnvironment(envKey);
    if (!target.ok) return json(res, 404, target);
    recordCallBearer(envKey, bearer);
    return json(res, 200, { ok: true, envKey, paired: true });
  }

  if (req.method === "DELETE" && url.pathname === "/api/pair") {
    // Revoking pairing is the HOST's act (voicebox-beads-yo1): requires host token
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "revoking a pairing is the host's act and requires the host token (x-voicebox-host-token); the page cannot hold it" });
    }
    const body = await readJson().catch(() => ({}));
    const envKey = (typeof body?.envKey === "string" ? body.envKey : null) ?? url.searchParams.get("envKey");
    if (!envKey) {
      return json(res, 400, { ok: false, refused: "bad-request", why: "revoking a pairing names the environment key (envKey)" });
    }
    const result = revokePairing(envKey);
    return json(res, result.ok ? 200 : 404, result);
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    // The LOCAL side (the proxy): the page names an environment by key; the host looks up the bearer
    // it holds for that key, attaches it, and forwards the call. The page never sees the bearer.
    const body = await readJson();
    const envKey = typeof body?.envKey === "string" ? body.envKey : null;
    const tool = typeof body?.tool === "string" ? body.tool : null;
    const args = body?.args && typeof body.args === "object" ? body.args : {};
    if (!envKey || !tool) {
      return json(res, 400, { ok: false, refused: "bad-request", why: "a proxied call names the environment key and the tool" });
    }
    // The local host is always callable and needs no pairing — saying "pair it" for it would name
    // the wrong remedy.
    if (envKey === "local") {
      const result = await callTool(tool, args);
      return json(res, result.ok === false ? 403 : 200, result);
    }
    const pairings = readPairings();
    if (!pairings.ok) return json(res, 500, pairings);
    const target = await resolveEnvironment(envKey);
    if (!target.ok) return json(res, target.refused === "environment-unreachable" ? 502 : 404, target);
    if (pairings.map[envKey]?.revoked) {
      return json(res, 403, { ok: false, refused: "pairing-revoked", why: `pairing for "${target.label ?? envKey}" was revoked by the host — re-pair before the host will carry a call to it` });
    }
    const bearer = bearerFor(envKey);
    if (!bearer) {
      return json(res, 403, { ok: false, refused: "environment-not-paired", why: `"${target.label ?? envKey}" is listed but not paired — pair it (an explicit act, gated by the host token) before the host will carry a call to it` });
    }
    // ATTEMPT-FIRST on the crossing act too: "did the call land?" must be answerable when
    // the process dies mid-flight, not only when the answer comes back.
    const att = logAttempt({ kind: "network", target: `${target.origin}/api/execute`, tool }, null);
    try {
      const answer = await fetch(`${target.origin}/api/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json", authorization: `Bearer ${bearer}`,
          ...(TASK_TOOLS.has(tool) ? { "x-voicebox-call-id": req.headers["x-voicebox-call-id"] ?? `call_${randomBytes(16).toString("hex")}` } : {}),
        },
        body: JSON.stringify({ envKey, tool, args }),
      });
      const out = await answer.json().catch(() => null);
      const attempt = att?.seq ?? null;
      const refusedAnswer = !out || out.ok === false;
      const completion = logAct({ kind: "network", target: `${target.origin}/api/execute`, tool }, refusedAnswer ? "refuse" : "allow", refusedAnswer ? (out?.refused ?? "bad-answer") : "proxied", refusedAnswer ? "refused" : "ok", out?.observed ?? null, null, attempt);
      return json(res, answer.status, out ?? { ok: false, refused: "bad-answer", why: "the remote answered something that was not JSON", logged: completion ? completion.seq : null, attempt });
    } catch (err) {
      const no = unreachable(target.label ?? envKey, target.origin);
      const attempt = att?.seq ?? null;
      const completion = logAct({ kind: "network", target: `${target.origin}/api/execute`, tool }, "refuse", no.refused, "refused", null, null, attempt);
      return json(res, 502, { ok: false, refused: no.refused, why: no.why, logged: completion ? completion.seq : null, attempt });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/execute") {
    // The REMOTE side: authenticate the bearer BEFORE anything is created (the /live hello-auth rule,
    // on the call path), then execute inside this host's own root. The envKey is resolved against THIS
    // host's registry FIRST — a bearer bound to a key that no longer exists here refuses by name, so a
    // re-keyed environment cannot be reached through its old credential. An unauthenticated call is
    // refused before any tool runs — the credential is checked, never trusted from the request, and
    // never echoed in the refusal.
    const auth = String(req.headers["authorization"] ?? "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const body = await readJson();
    const envKey = typeof body?.envKey === "string" ? body.envKey : null;
    if (!envKey) return json(res, 400, { ok: false, refused: "bad-request", why: "an execute names the environment key it is for" });
    const known = await resolveEnvironment(envKey);
    if (!known.ok) return json(res, 404, { ok: false, refused: "unknown-environment", why: `no environment with key '${envKey}' is in this host's registry — the credential that names it does not reach anything` });
    const check = bearerOk(envKey, bearer);
    if (!check.ok) {
      return json(res, 403, { ok: false, refused: check.refused, why: check.why });
    }
    const tool = typeof body?.tool === "string" ? body.tool : null;
    const args = body?.args && typeof body.args === "object" ? body.args : {};
    if (!tool) return json(res, 400, { ok: false, refused: "bad-request", why: "an execute names the tool" });
    // Credential identity is separate from the executing host's self key. It is never
    // accepted from model arguments, and current pairing auth is rechecked on EVERY read.
    const authority = {
      owner: createHash("sha256").update(`voicebox-task-owner\0${envKey}\0${bearer}`).digest("hex"),
      callId: req.headers["x-voicebox-call-id"],
    };
    const result = await callTool(tool, args, authority);
    return json(res, result.ok === false ? 403 : 200, result);
  }

  json(res, 404, { error: "not found" });
}

// The host survives a bad turn: malformed JSON, a throwing handler, anything —
// an error message and an audit entry, and the server keeps serving.
const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    console.error(`[audit] ${new Date().toISOString()} ${req.method} ${req.url}:`, e?.message ?? e);
    try { json(res, 500, { error: "internal error — the turn was not executed" }); } catch { /* response gone */ }
  }
});
process.on("uncaughtException", (e) => console.error(`[uncaught] ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => console.error(`[unhandledRejection] ${e?.reason ?? e}`));

// ── the live voice socket ─────────────────────────────────────────────────
// Page ⇄ /live ⇄ Gemini Live. Binary frames are PCM16 audio (16 kHz up,
// 24 kHz down); text frames are JSON control ({"type":"text"} turns,
// {"type":"stop"}). The session owns the readiness gate and the model label.
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // ── the routed-acts channel ───────────────────────────────────────────────
  // The environment page connects here and ANSWERS acts the server routes to it
  // (core/dispatch.ts: a page-owned root is executed by the page). JSON text frames only:
  // a hello, then answer envelopes the channel settles waiting calls with. One executor
  // page at a time — a second connection replaces the first, and the page-side root check
  // (root-not-mine) is what keeps an act addressed to a root that page does not own from
  // landing anywhere.
  //
  // THE EXECUTOR ENTITLEMENT GATE:
  // An unauthenticated connection must NOT become the executor. Without this gate, any
  // cross-origin webpage (CSWSH) or rogue local process could connect to /channel, become
  // pageSocket, and spoof execution results (via:"page") for writes it never performed.
  //
  // Entitlement rule (mirroring /live):
  //   · The LOCAL PAGE is entitled by construction: connects with same-origin header (Origin).
  //   · Any NON-LOCAL or REMOTE connection MUST present a valid pairing bearer in hello:
  //     {"type":"hello","role":"environment","bearer":"vbx_…"}.
  //   · Unauthenticated or non-matching connections receive a named refusal with a remedy
  //     ("executor-unauthenticated" / "bearer-refused") and are closed before pageSocket is set.
  //
  // WHAT THIS DOES NOT PROTECT AGAINST (same-machine non-browser processes are out of scope):
  // A non-browser process on the local machine (curl, script) can forge an Origin header on raw loopback TCP.
  // Closing that requires a per-process session token minted into the served HTML (the environment-identity milestone);
  // this gate closes Cross-Site WebSocket Hijacking from other browser tabs and unauthenticated remote peers.
  if (url.pathname === "/channel") {
    const ws = wsUpgrade(req, socket);
    if (!ws) { socket.destroy(); return; }

    const selfPort = boundPort ?? PORT;
    const localOrigins = new Set([
      `http://127.0.0.1:${selfPort}`,
      `http://localhost:${selfPort}`,
      `http://[::1]:${selfPort}`,
    ]);
    const claimsToBeTheLocalPage = typeof req.headers.origin === "string" && localOrigins.has(req.headers.origin);

    const refuseChannel = (refused, why) => {
      try {
        ws.send(JSON.stringify({ type: "refused", refused, why }));
      } catch { /* the socket may be gone */ }
      ws.close(1008, refused);
    };

    const attachExecutor = (label) => {
      if (pageSocket && pageSocket !== ws) {
        console.error(`[channel] a second page connected (${label}) — replacing the first (root-not-mine guards every act)`);
      }
      pageSocket = ws;
      console.error(`[channel] the ${label} connected — routed acts have someone to ask`);
      ws.on("message", (data) => {
        if (typeof data !== "string") return; // the channel speaks JSON text; anything else is noise
        let msg = null;
        try { msg = JSON.parse(data); } catch { /* not JSON — not an answer */ }
        if (msg?.type === "hello") {
          return;
        }
        pageChannel.deliver(data);
      });
      ws.on("close", () => {
        // Only the CURRENT socket's close empties the chair — an older tab closing must not
        // abandon calls a newer tab could answer.
        if (pageSocket === ws) {
          pageSocket = null;
          pageChannel.abandon();
          permissions.disconnect();
          console.error("[channel] the page disconnected — routed acts will answer no-page until it returns");
        }
      });
      ws.on("error", () => {});
    };

    if (claimsToBeTheLocalPage) {
      attachExecutor("local environment page");
      return;
    }

    const HELLO_BOUND_MS = Number(process.env.VOICEBOX_HELLO_BOUND_MS ?? 5000);
    const helloDeadline = setTimeout(
      () => refuseChannel(
        "executor-unauthenticated",
        `this connection did not present the executor entitlement. The executor channel requires ` +
          `the local page origin or a valid pairing bearer in the first hello frame {"type":"hello","bearer":"<bearer>"}; ` +
          `nothing arrived within ${HELLO_BOUND_MS}ms.`,
      ),
      HELLO_BOUND_MS,
    );

    let awaitingHello = true;
    ws.on("message", (data) => {
      if (!awaitingHello) return;
      awaitingHello = false;
      clearTimeout(helloDeadline);
      let frame = null;
      try { frame = JSON.parse(String(data)); } catch { /* fall through to refusal */ }
      const bearer = typeof frame?.bearer === "string" ? frame.bearer : null;
      if (frame?.type !== "hello" || !bearer) {
        refuseChannel(
          "executor-unauthenticated",
          'the first frame must be {"type":"hello","bearer":"<the pairing bearer this host issued>"} unless you are ' +
            'the page this host serves — this connection did not present the executor entitlement.',
        );
        return;
      }
      const check = checkBearerAccepted(bearer);
      if (!check.ok) {
        refuseChannel(check.refused, check.why);
        return;
      }
      ws.envKey = check.envKey;
      ws.bearer = bearer;
      attachExecutor(`paired executor (${frame.role ?? "environment"})`);
    });
    return;
  }
  if (url.pathname !== "/live") { socket.destroy(); return; }
  const ws = wsUpgrade(req, socket);
  if (!ws) { socket.destroy(); return; }

  // ── THE HELLO GATE: entitlement BEFORE provider spend (bead voicebox-beads-eet) ─────────────────────
  //
  // THE DEFECT, measured before this existed: an unauthenticated peer connected to /live and received the
  // rate frame, then transport-open, then ready — a real provider session, created and paid for, for a
  // connection nothing had asked about. The refusal that followed was a cleanup, not a gate.
  //
  // So this socket does not reach the provider until the connection has shown it is entitled to one:
  //
  //   · THE LOCAL PAGE is entitled by construction: a page this process serves announces itself with its
  //     own Origin, and this host does not hand credentials to a page. Same origin, no hello needed.
  //   · EVERY OTHER PEER presents the pairing bearer its host issued, in the FIRST frame:
  //     {"type":"hello","bearer":"vbx_…"}. Missing, malformed or non-matching is a NAMED refusal with the
  //     remedy in it, and the socket is closed BEFORE any session exists.
  //   · THE BOUND exists because silence is not a credential either: a peer that says nothing costs a close.
  //
  // WHAT THIS DOES NOT CLAIM, stated here rather than discovered later: a non-browser client can send any
  // Origin it likes, so "same origin" is a claim the peer makes, not a proof. This gate stops an
  // unauthenticated peer from costing a session and makes the PAIRED path enforceable; a per-process page
  // token minted into the served HTML is what would close the claim itself, and it belongs with the
  // environment-identity work rather than here.
  const selfPort = boundPort ?? PORT;
  const localOrigins = new Set([
    `http://127.0.0.1:${selfPort}`,
    `http://localhost:${selfPort}`,
    `http://[::1]:${selfPort}`,
  ]);
  const claimsToBeTheLocalPage = typeof req.headers.origin === "string" && localOrigins.has(req.headers.origin);

  const refuseLive = (refused, why) => {
    try { ws.send(JSON.stringify({ type: "refused", refused, why })); } catch { /* the socket may be gone */ }
    ws.close(1008, refused);
  };

  const beginSession = () => {
    // Snapshot once: rate, dial and later state frames describe this session,
    // even if settings change while it is running (voicebox-beads-94c).
    const provider = agentSettings.provider;
    const model = PROVIDERS[provider].model;
    // STEP 2 OF THE RATE WORK: the page is told what rate to capture at BEFORE any audio is sent, ever.
    //
    // The defect this closes (journal-6g0): the browser captured at 16 kHz, the OpenAI provider declared
    // 24 kHz to its vendor, and the PCM was forwarded unchanged — the provider told OpenAI one thing and sent
    // another, and nothing in the path could notice. It hid because Gemini also takes 16 kHz: with one
    // implementation nobody had to negotiate. So the FIRST frame on this socket is the requirement, it comes
    // from the provider that will receive the audio, and a provider that has not declared one is REFUSED —
    // guessing a provider's rate is the defect, so the host will not guess.
    let inputRate = null;
    try {
      inputRate = inputRateRequiredBy(provider);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: e?.message ?? String(e) }));
      ws.close(1011, "provider has not declared the input rate its protocol requires");
      return;
    }
    ws.send(JSON.stringify({ type: "rate", inputRate, provider }));

    let session = null;
    try {
      liveSessionsCreated += 1;
      session = createLiveSession({
        // THE AGENT SETTINGS APPLY HERE, which is what stops them being dead controls: the provider a
        // person chose is the provider this session dials, and its model comes with it.
        provider,
        model,
        // The agent settings ride the seam: the personality composed over the mandatory base
        // (composeAgentInstruction cannot be handed a base — that is the mechanism), and the
        // voice the person chose for THIS provider. Both land in the provider's setup.
        instruction: composeAgentInstruction(agentSettings.personality),
        voice: agentSettings.voice || undefined,
        onAudioOut: (pcm, mime) => { if (pcm.length > 4) ws.send(pcm); },
        onText: (text, role) => ws.send(JSON.stringify({ type: "text", role, text })),
        onState: (state, detail) => ws.send(JSON.stringify({ type: "state", state, detail, model })),
        // The voice gets the SAME verbs the text path resolves to, from the ONE
        // command list (lib/commands.mjs) — and each call runs through the SAME
        // executor, so containment, refusal names and the audit are identical
        // whichever path the words arrive on.
        tools: functionDeclarations(),
        systemInstruction: liveSystemInstruction(),
        onToolCall: async (calls) => {
          const responses = [];
          const seen = [];
          for (const call of calls) {
            // EVERY command in a batch answers, including the ones that fail — a batch that
            // sends nothing is indistinguishable from a hang (astra's live-tools review,
            // 2026-09-20: one failing command swallowed every sibling's response). So the
            // mapping is validated, the executor is wrapped, and a throw becomes a NAMED
            // refusal rather than a swallowed outcome.
            const action = commandToAction(call.name, call.args);
            let result;
            if (!action) {
              result = { ok: false, refused: "unknown-command", error: `unknown command: '${call.name}' — the only commands are in lib/commands.mjs` };
            } else if (action.refused) {
              result = { ok: false, refused: action.refused, error: `refused: ${action.refused}`, why: action.why };
            } else {
              try {
                result = await execute({ ...action, turn: "live" });
              } catch (e) {
                result = { ok: false, refused: "exec-threw", error: `refused: exec-threw`, why: `the executor threw instead of answering: ${e?.message ?? e}` };
              }
            }
            responses.push({ id: call.id, name: call.name, response: { result } });
            seen.push({ name: call.name, ok: result.ok, action: result.action ?? result.error });
          }
          const answered = session.sendToolResponse(responses);
          if (!answered) {
            // The acts above may have LANDED while the answer could not be sent (the gate
            // refuses a response before ready). That is the worst silence of the three, so it
            // is the loudest line: which acts ran, and that the model never heard.
            console.error(`[live] tool-call ${seen.map((s) => `${s.name}:${s.ok ? "ok" : "refused"}`).join(", ")} — toolResponse NOT SENT (the session was not ready; the host gates tool-call events on ready, so this means the gate was bypassed)`);
          } else {
            console.error(`[live] tool-call ${seen.map((s) => `${s.name}:${s.ok ? "ok" : "refused"}`).join(", ")} — toolResponse sent`);
          }
          // The page hears about it too (additive: today's client ignores the
          // type; a UI lane can render it).
          ws.send(JSON.stringify({ type: "tool", calls: seen }));
        },
      });
      // WHICH session, AND FOR WHOM. The socket is recorded with it because a later close must clear only
      // its OWN session: with two peers connected, the first to leave would otherwise report the second as
      // gone — the same class of lie as the flag never clearing at all, told the other way round.
      runningSession = {
        provider: session.state?.provider ?? provider,
        startedAt: new Date().toISOString(),
        socket: ws,
      };
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: e?.message ?? String(e) }));
      ws.close(1011, "live session failed to start");
      return;
    }

    ws.on("message", (data) => {
      if (typeof data === "string") {
        let msg = null;
        try { msg = JSON.parse(data); } catch { /* not JSON — ignore */ }
        if (msg?.type === "text" && typeof msg.text === "string") session.sendText(msg.text);
        if (msg?.type === "stop") { session.close(); ws.close(); }
        return;
      }
      // A binary frame is a PCM16 audio frame from the page's microphone.
      // VALIDATE before forwarding — this is not defensive padding. Measured
      // (ds-flash-1b, 2026-09-19): a single 3-byte frame reaches the model and
      // the upstream closes 1007 "Request contains an invalid argument" — the
      // SESSION dies while the page's socket stays open, so the user keeps
      // talking into nothing. One malformed frame must cost a frame, never the
      // conversation. PCM16 is always a non-empty EVEN number of bytes, and a
      // frame past a bounded size is a fault, not audio.
      const frameError =
        data.length === 0 ? "empty audio frame" :
        data.length % 2 !== 0 ? `odd-length audio frame (${data.length} bytes — PCM16 is even-length)` :
        data.length > 1_048_576 ? `audio frame too large (${data.length} bytes)` :
        null;
      if (frameError) {
        ws.send(JSON.stringify({ type: "error", error: `dropped malformed audio frame — ${frameError} (the session is fine)` }));
        return; // rejected WITHOUT forwarding: one bad frame costs a frame.
      }
      session.sendAudio(data.toString("base64"));
    });
    // A SESSION IS RUNNING ONLY WHILE SOMEBODY IS CONNECTED TO IT. This flag is what tells a person
    // whether it is safe to change the provider, so it must not outlive the socket that started it: it was
    // set and never cleared, and /api/health reported `running: true` for the life of the process after the
    // first session, with nobody attached. (tests/live-session-flag.test.mjs is the falsifier: it opens a
    // real session through this route, closes the socket, and requires the payload to flip back.)
    const endSession = () => {
      session.close();
      if (runningSession?.socket === ws) runningSession = null;
    };
    ws.on("close", endSession);
    ws.on("error", endSession);
  };

  if (claimsToBeTheLocalPage) { beginSession(); return; }

  const HELLO_BOUND_MS = 5000;
  const helloDeadline = setTimeout(
    () => refuseLive(
      "unauthenticated-call",
      `this socket asked for a live session — which is a provider session, and provider spend — without ` +
        `identifying itself. The first frame must be {"type":"hello","bearer":"<the pairing bearer this host ` +
        `issued>"} unless you are the page this host serves; nothing arrived within ${HELLO_BOUND_MS}ms.`,
    ),
    HELLO_BOUND_MS,
  );
  // `ws` here is this project's own zero-dependency socket (lib/ws-server.mjs), which has `on` and NOT
  // `once` — my first version called `once`, it threw inside the handler, and every remote peer fell
  // through to the timeout instead of being read. The flag below is the same idea, on the API that exists.
  let awaitingHello = true;
  ws.on("message", (data) => {
    if (!awaitingHello) return; // from here the session's own handler owns the frames
    awaitingHello = false;
    clearTimeout(helloDeadline);
    let frame = null;
    try { frame = JSON.parse(String(data)); } catch { /* fall through to the refusal below */ }
    const bearer = typeof frame?.bearer === "string" ? frame.bearer : null;
    if (frame?.type !== "hello" || !bearer) {
      refuseLive(
        "unauthenticated-call",
        'the first frame must be {"type":"hello","bearer":"<the pairing bearer this host issued>"} — a live ' +
          'session costs provider spend, so the entitlement is checked before the session is built.',
      );
      return;
    }
    const check = checkBearerAccepted(bearer);
    if (!check.ok) {
      refuseLive(check.refused, check.why);
      return;
    }
    ws.envKey = check.envKey;
    ws.bearer = bearer;
    beginSession();
  });

});

/**
 * BINDING IS RETRIED, NOT FATAL — and this is the union of two fixes to the same defect, so say
 * which half came from where.
 *
 * The defect (five sightings in one day — Paul's console, coord's curls, the acceptance gate, and an
 * eight-hour stretch where the front served while the API was dead): a `node --watch` supervisor
 * restarts the child on every landing, the fresh child lost the bind race to the dying old one, and
 * then NOTHING restarted it until the next file change. A port serving nothing, with the page none
 * the wiser. What produces the taken port is usually ANOTHER SUPERVISOR (measured: the manager swept
 * two strays in one recovery), so:
 *
 *   · THE RETRY IS THE SAFETY NET, sized for that evidence: 30s, with a NAMED line at each attempt,
 *     because a retry nobody can see is a hang that happens to succeed. When the deadline passes the
 *     process exits with a sentence naming the port and how to find the holder — a dead port has to be
 *     announced, not left as a stack trace nobody reads.
 *   · THE GRACEFUL RELEASE IS THE FIX: a supervisor restarts by signalling its child, and that child
 *     letting go immediately is what stops the next start from ever seeing a taken port. SIGINT too,
 *     since half the actors here start it by hand.
 *   · AND ERRORS AFTER BINDING ARE NOT SILENCE: a single steady-state handler, so a later socket
 *     error says what happened instead of taking the process down with a stack trace.
 */
const BIND_RETRY_MS = Number(process.env.VOICEBOX_BIND_RETRY_MS ?? 250);
const BIND_DEADLINE_MS = Number(process.env.VOICEBOX_BIND_DEADLINE_MS ?? 30000);

function bindWithRetry(port, startedAt = Date.now()) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      const waited = Date.now() - startedAt;
      if (error?.code === "EADDRINUSE" && waited < BIND_DEADLINE_MS) {
        console.error(
          `[bind] waiting for 127.0.0.1:${port} to be released — held by another process (EADDRINUSE), ` +
            `${waited}ms so far; retrying every ${BIND_RETRY_MS}ms for up to ${BIND_DEADLINE_MS}ms. ` +
            `A supervisor shutting down holds it briefly; a second supervisor holds it until it is stopped.`,
        );
        setTimeout(() => resolve(bindWithRetry(port, startedAt)), BIND_RETRY_MS);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

try {
  const bound = await bindWithRetry(PORT);
  boundPort = bound; // from here the origin check can recognise this server's own page
  // The REAL port, not the requested one: PORT=0 asks the OS for a free port, and a test suite that
  // binds an ephemeral port has to be able to read back which one it got. A suite that pins a fixed
  // port cannot run beside another, and the failure appears in someone else's lane as an unexplained
  // block — the most expensive kind, because they cannot tell it is your test.
  console.log(
    `voicebox on http://127.0.0.1:${bound} — provider: ${PROVIDER}, root: ${active ? active.root.path : "(none declared)"}`,
  );
} catch (error) {
  console.error(
    `[bind] giving up after waiting ${BIND_DEADLINE_MS}ms for 127.0.0.1:${PORT} (${error?.code ?? error?.message}). ` +
      `Something else is serving that port — find it (ss -ltnp | grep ${PORT}) and stop it, or start this on another port.`,
  );
  process.exit(1);
}

// AND THE OUTGOING PROCESS LETS GO. A supervisor restarts by signalling the child; exiting on the
// signal releases the socket immediately, instead of leaving the next process to collide with a
// socket this one still holds. The force-exit is for open sockets (the live-voice WebSocket keeps
// `close()` waiting), so a clean stop never becomes a hang.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref(); // sockets must not outlive the exit
  });
}

// Once bound, an error is still not silence: a socket-level failure says what it was rather than
// ending the process with a stack trace nobody reads.
server.on("error", (e) => {
  console.error(`[server] socket error on 127.0.0.1:${PORT} (${e?.code ?? e})`);
});
