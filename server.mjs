#!/usr/bin/env node
// voicebox server — the thinnest host for the loop:
//   browser captures a spoken turn -> POST /api/turn -> resolver -> action -> executor.
// Zero dependencies: node:http for the server, node:fs for the workspace.
// The resolver is a provider seam (lib/resolver.mjs) — swap it, don't rewrite the server.
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTurn } from "./lib/resolver.mjs";
import { ROOT_FACTS, ROOT_NOT_DECLARED, describeRoot, noRootDeclared, reachableFrom, reachableFromEnvironment, resolveInRoot, rootVanished } from "./core/root.ts";
import { normaliseRelativeDir, parentDir } from "./core/paths.ts";
import { CORE_FS_DESCRIPTOR, createUnifiedDiff, dispatchFor } from "./core/dispatch.ts";
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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ENV_UNREACHABLE,
  listUnreadable,
  parseEnvironment,
  unreachable,
} from "./core/environment.ts";
import * as extensions from "./lib/extensions.mjs";
import { sweepOrphanedProbeMarkers } from "./tools/sandbox-probe.mjs";
import { createTaskHost, installTaskExecutor, protectedAuditPath, TASK_TOOLS } from "./lib/tasks.mjs";
import { createPermissionPolicy } from "./lib/permission-policy.mjs";
import { createPiAcpExecutor } from "./lib/pi-acp.mjs";
import { bootFence } from "./lib/fence-provider.mjs";
import { SOURCE_DIRS } from "./lib/browser-sources.mjs";
import { bootUnitFence, stopUnitFence } from "./lib/unit-fence-provider.mjs";
import { createHarnessInventory } from "./lib/harness-inventory.mjs";
import { createAgentRegistry, listHarnessesWithConfiguredAgents, publicAgentProjection } from "./lib/harness-config.mjs";
import {
  createFleetManager,
  publicFleetProjection,
  parseTargetKey,
  formatTargetKey,
  resolveFleetTarget,
} from "./lib/fleet.mjs";
import { upgrade as wsUpgrade } from "./lib/ws-server.mjs";
import { createLiveSession, LIVE_MODEL, inputRateRequiredBy } from "./lib/live-session.mjs";
import { commandToAction, functionDeclarations, liveSystemInstruction } from "./lib/commands.mjs";
import { readProjectInstruction } from "./lib/project-instruction.mjs";
import { installColorConsole } from "./lib/logger.mjs";
// The state directories have ONE owner; this file no longer computes its own copy of any of them
// (voicebox-beads-y5k: `VOICEBOX_WORKSPACE` and `VOICEBOX_EXTENSIONS_DIR` were each resolved here
// AND in lib/extensions.mjs, with the same fallbacks written twice).
import { workspaceDir, workspaceDeclared, extensionsDir } from "./lib/state-dirs.mjs";

installColorConsole();

// Module-relative, decoded: `new URL(...).pathname` percent-encodes spaces and
// silently points every read at a directory that does not exist.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Movable workspace (tests point it at scratch; the fact is owned by lib/state-dirs.mjs).
const WORKSPACE = workspaceDir();

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
const HOST_DIR = extensionsDir();
const PAIRINGS_FILE = path.join(HOST_DIR, ".pairings.json");
// Stale pending approval files must never survive a restart (voicebox-beads-62f).
rmSync(path.join(HOST_DIR, ".pending-approval.json"), { force: true });

// Stale sandbox probe markers from killed runs must never survive (voicebox-beads-ebq).
sweepOrphanedProbeMarkers(ROOT);
if (process.cwd() !== ROOT) sweepOrphanedProbeMarkers(process.cwd());

// ── IN-ROOM SESSION AUTHORIZATION (voicebox-beads-5jl) ──────────────────────────
// Minted per server process and embedded into the served index.html. Allows in-room UI actions
// (like reconfiguring bounds or revoking extensions) without exposing or discovering .token on disk.
const ROOM_SESSION_TOKEN = randomBytes(24).toString("hex");

function hasExtensionAuthority(req) {
  // 1. Host token from CLI / script callers
  if (extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) return true;

  // 2. In-room session token embedded in the served HTML
  const sessionToken = req.headers["x-voicebox-session-token"];
  if (typeof sessionToken === "string" && sessionToken && sessionToken === ROOM_SESSION_TOKEN) {
    return true;
  }

  // 3. Request from the local page origin
  const selfPort = boundPort ?? PORT;
  const localOrigins = new Set([
    `http://127.0.0.1:${selfPort}`,
    `http://localhost:${selfPort}`,
    `http://[::1]:${selfPort}`,
    `http://127.0.0.1:5173`,
    `http://localhost:5173`,
  ]);
  if (typeof req.headers.origin === "string" && localOrigins.has(req.headers.origin)) {
    return true;
  }
  return false;
}

// ── LOOPBACK SESSION AUTH (docs/13 §4 — voicebox-beads-kkc, epic 2gq) ─────────────────────────
// The residual boundary 5c1 named but did not close: on loopback TCP any local process can write
// `Origin: http://127.0.0.1:<port>` on a raw socket, so the Origin check distinguishes BROWSER
// contexts but not which local PROCESS connects. docs/13 §1 rules out minting a token into the
// openly-served HTML (anyone who can reach the port can fetch that HTML); §4 lands Option A, the
// Jupyter/code-server pattern, phased as an OPT-IN gate:
//
//   VOICEBOX_LOOPBACK_AUTH=1  →  the page and every API/WS route answer only with a session
//   cookie, and the only way in is a ONE-TIME bootstrap ticket the server mints and prints at
//   startup (or mints on demand for a holder of the host token — the same 0600 authority as
//   admission). The ticket redeems once, on the page route, into an HttpOnly SameSite=Strict
//   cookie; a local process that cannot read the ticket output (a different UID, a container)
//   can no longer fetch the page or take the executor chair by forging an Origin header.
//
// DEFAULT OFF: every check below asks LOOPBACK_AUTH first, so the default surface is byte-for-
// byte the 5c1 behaviour and every existing suite runs unchanged. The secret is EPHEMERAL and
// PER-PROCESS — a restart mints a new one and silently invalidates every issued cookie, which
// is the honest failure mode: the remedy (open the URL the new process printed) is the launch.
const LOOPBACK_AUTH = process.env.VOICEBOX_LOOPBACK_AUTH === "1";
const SESSION_COOKIE = "vb_session";
const LOOPBACK_SESSION = randomBytes(32).toString("hex");
const outstandingBootstrapTickets = new Set(); // single-use: consumed on redemption
function mintBootstrapTicket() {
  const ticket = randomBytes(32).toString("hex");
  outstandingBootstrapTickets.add(ticket);
  return ticket;
}
function consumeBootstrapTicket(ticket) {
  if (typeof ticket !== "string" || !outstandingBootstrapTickets.has(ticket)) return false;
  outstandingBootstrapTickets.delete(ticket);
  return true;
}
function sessionCookieOk(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return false;
  const match = header.split(/;\s*/).find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return false;
  const provided = Buffer.from(match.slice(SESSION_COOKIE.length + 1));
  const expected = Buffer.from(LOOPBACK_SESSION);
  // Length differs → not ours; timingSafeEqual throws on length mismatch, so gate on it first.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function claimsToBeTheLocalPage(req, localOrigins) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
  if (!origin || !localOrigins.has(origin)) return false;
  // WITH the gate on, a matching Origin is no longer entitlement by itself — the browser proves
  // the session by presenting the cookie the bootstrap ticket minted. A script that forges the
  // header without the cookie falls through to the bearer-hello path and is refused there, by name.
  return !LOOPBACK_AUTH || sessionCookieOk(req);
}

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
  sweepOrphanedProbeMarkers(ROOT);
  if (process.cwd() !== ROOT) sweepOrphanedProbeMarkers(process.cwd());
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE_SCRIPT], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      sweepOrphanedProbeMarkers(ROOT);
      if (process.cwd() !== ROOT) sweepOrphanedProbeMarkers(process.cwd());
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
const bootRoot = workspaceDeclared();
if (bootRoot) {
  const declared = path.resolve(bootRoot);
  if (existsSync(declared) && statSync(declared).isDirectory()) {
    active = { project: path.basename(declared), root: { kind: "machine", path: realpathSync(declared), environment: SELF_ENVIRONMENT }, declaredAt: new Date().toISOString(), declaredBy: "VOICEBOX_WORKSPACE" };
  } else {
    console.error(`[root] VOICEBOX_WORKSPACE='${bootRoot}' is not a directory — no root is declared`);
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

const AGENTS_FILE = path.join(HOST_DIR, ".agents.json");
const serverAgentStorage = {
  getItem() {
    try { return readFileSync(AGENTS_FILE, "utf8"); } catch { return null; }
  },
  setItem(_k, v) {
    mkdirSync(HOST_DIR, { recursive: true });
    if (existsSync(AGENTS_FILE)) {
      accessSync(AGENTS_FILE, constants.W_OK);
    }
    const tmp = `${AGENTS_FILE}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tmp, v, { mode: 0o600 });
      renameSync(tmp, AGENTS_FILE);
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    }
  },
};
const agentRegistry = createAgentRegistry({ storage: serverAgentStorage });

const tasks = createTaskHost({
  environment: SELF_ENVIRONMENT, instance: INSTANCE, boot: BOOT,
  addressKey: readFileSync(path.join(HOST_DIR, ".host-token")),
  root: () => active,
  agentRegistry,
  onUpdate: (view) => {
    const frame = JSON.stringify({ type: "task", task: view, delivery: view.delivery });
    try { pageSocket?.send(frame); } catch {}
    try { runningSession?.socket?.send(frame); } catch {}
  },
});

const fleetManager = createFleetManager({
  localEnvironmentKey: "local",
  localRegistry: agentRegistry,
  getEnvironments: async () => {
    const list = await environmentsWithStatus();
    return list.environments;
  },
  resolveEnvironment: async (envKey) => {
    if (envKey === "local" || envKey === SELF_ENVIRONMENT) {
      return { ok: true, local: true, key: envKey };
    }
    const resolved = await resolveEnvironment(envKey);
    if (!resolved.ok) {
      return {
        ok: false,
        refused: "environment-unknown",
        why: `no environment with key '${envKey}' is in the registry — declare it before calling it`,
      };
    }
    const bearer = bearerFor(envKey);
    return {
      ok: true,
      local: false,
      key: envKey,
      label: resolved.label,
      origin: resolved.origin,
      paired: Boolean(bearer),
      bearer,
    };
  },
  fetchRemoteAgents: async (envKey, auth) => {
    const target = await resolveEnvironment(envKey);
    if (!target.ok || !target.origin) return [];
    const bearer = auth?.bearer || bearerFor(envKey);
    if (!bearer) return [];
    const url = new URL("/api/agents", target.origin);
    const headers = { authorization: `Bearer ${bearer}` };
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      const body = await res.json();
      return Array.isArray(body.agents) ? body.agents : [];
    } catch {
      return [];
    }
  },
  remoteContact: async (envKey, { agentId, message, sessionId, auth }) => {
    const target = await resolveEnvironment(envKey);
    if (!target.ok || !target.origin) {
      return {
        ok: false,
        refused: "environment-unknown",
        why: `Environment '${envKey}' not found in registry`,
      };
    }
    const bearer = auth?.bearer || bearerFor(envKey);
    if (!bearer) {
      return {
        ok: false,
        refused: "environment-not-paired",
        why: `Environment '${envKey}' is listed but not paired`,
      };
    }
    const url = new URL("/api/fleet/contact", target.origin);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ target: `${envKey}/${agentId}`, message, sessionId }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => null);
      if (!data) {
        return {
          ok: false,
          refused: "environment-unreachable",
          why: `remote environment '${envKey}' did not answer with JSON`,
        };
      }
      return data;
    } catch (err) {
      return {
        ok: false,
        refused: "environment-unreachable",
        why: `environment "${target.label ?? envKey}" at ${target.origin} is unreachable: ${err?.message ?? err}`,
      };
    }
  },
  tasks,
});

const permissions = createPermissionPolicy();

const HARNESS = process.env.VOICEBOX_HARNESS ?? null;
if (HARNESS === "pi" || HARNESS === "pi-acp") {
  const piExecutor = createPiAcpExecutor({
    decide: permissions.decide,
    root: () => active?.root,
  });
  installTaskExecutor(piExecutor);
  agentRegistry.register({
    id: "pi",
    name: "Pi",
    harness: "pi",
    adapter: "pi-acp",
    environmentKey: SELF_ENVIRONMENT,
    isDefault: true,
  });
} else if (HARNESS === "claude") {
  installTaskExecutor({
    check({ input }) {
      return { ok: false, refused: "adapter-not-configured", why: "No Voicebox task adapter is configured for this CLI; configure an adapter before delegating." };
    },
    async run() {
      throw Object.assign(new Error("No Voicebox task adapter is configured for this CLI"), { refused: "adapter-not-configured" });
    },
  });
  agentRegistry.register({
    id: "claude",
    name: "Claude",
    harness: "claude",
    adapter: "claude-code",
    environmentKey: SELF_ENVIRONMENT,
    isDefault: true,
  });
}

function callTool(tool, args, authority) {
  return (TASK_TOOLS.has(tool) || tool === "cancel_task") ? tasks.call(tool, args, authority) : extensions.callTool(tool, args);
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
      // WHAT ROOT THIS CALL NAMES. A declared root is named so the page can refuse a call that is not
      // for the project it holds (browser/acts.ts: root-not-mine). With NO root declared the field is
      // omitted on purpose — undefined drops out in JSON — and the page answers for its OWN project:
      // that is the fqq path, where a browser-stored project is listed and read without the server ever
      // declaring a root, and the page's own descriptor is the only authority for its storage.
      ...(active ? { root: active.root } : {}),
      name: String(action.name ?? ""),
      ...(action.content != null ? { content: String(action.content) } : {}),
      ...(action.oldText != null ? { oldText: String(action.oldText) } : {}),
      ...(action.newText != null ? { newText: String(action.newText) } : {}),
      ...(action.query != null ? { query: String(action.query) } : {}),
      ...(action.agent != null ? { agent: String(action.agent) } : {}),
      ...(action.task != null ? { task: String(action.task) } : {}),
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
  if (action.verb === "delete") {
    return { ok: true, action: `deleted ${observed.name ?? action.name} — observed by the page`, file: observed.name ?? action.name, via: "page", root: active.root, logged: observed.auditSeq ?? null };
  }
  if (action.verb === "edit") {
    return { ok: true, action: `edited ${observed.name ?? action.name} (${observed.bytes ?? 0} bytes) — observed by the page`, file: observed.name ?? action.name, via: "page", root: active.root, logged: observed.auditSeq ?? null };
  }
  if (action.verb === "diff") {
    return { ok: true, action: `diff ${observed.name ?? action.name}`, file: observed.name ?? action.name, diff: observed.diff ?? "", changed: Boolean(observed.changed), via: "page", root: active.root };
  }
  if (action.verb === "list_agents") {
    return { ok: true, action: "listed agents", agents: observed.agents ?? [], count: observed.agents?.length ?? 0, via: "page", root: active?.root ?? null };
  }
  if (action.verb === "delegate_task") {
    return { ok: true, action: `delegated task to ${observed.agent ?? action.agent}`, task: observed.task, address: observed.address, via: "page", root: active?.root ?? null };
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
}
// voicebox-beads-4kp: booted L1.5 units are transients that outlive this process by construction.
// Track every key this process booted and stop them on exit — the sandbox a lane forgot must not
// hold a port and its RSS until reboot. (The RuntimeMaxSec property in fence-unit.sh is the
// backstop; this is the polite path.)
const bootedUnitKeys = new Set();
const stopBootedUnits = () => {
  for (const key of bootedUnitKeys) {
    stopUnitFence(key).catch(() => {});
  }
};
process.on("beforeExit", stopBootedUnits);
process.on("SIGTERM", () => { stopBootedUnits(); process.exit(0); });
process.on("SIGINT", () => { stopBootedUnits(); process.exit(0); });

const PORT = Number(process.env.PORT ?? 8787);

// `--doctor` — WHAT IS SET, WHAT IS NOT, AND WHAT THAT MEANS. Written because the answer
// to "why is it doing that" was always "one of eleven environment variables", and nothing
// listed them. (Paul, 2026-09-23: "so I can see what is set and what isn't".)
if (process.argv.includes("--doctor")) {
  const set = (v) => v !== undefined && v !== "";
  const mark = (v) => (set(v) ? "SET    " : "unset  ");
  const line = (name, dflt, why) => {
    const v = process.env[name];
    const eff = set(v) ? v : dflt;
    console.log(`  ${mark(v)}${name.padEnd(26)} ${String(eff).padEnd(26)} ${why}`);
  };
  console.log(`
voicebox doctor — what this process would do, and why.

PATHS
`);
  line("VOICEBOX_WORKSPACE", "(none declared)", "a root at boot; without it every write refuses");
  line("VOICEBOX_EXTENSIONS_DIR", extensionsDir(), "where extensions live");
  line("VOICEBOX_SANDBOX_HOMES", "(default)", "sandbox home root");
  line("VOICEBOX_INSTANCE", "machine", "this instance's name");

  console.log(`
CHOICES — these are BOOT decisions, not settings for a running session
`);
  line("VOICEBOX_RESOLVER", "script", "the TURN BRAIN: script | gemini");
  line("VOICEBOX_LIVE_PROVIDER", "gemini", "the LIVE TRANSPORT: gemini | openai");
  line("VOICEBOX_HARNESS", "(none)", "the TASK HARNESS: pi");
  if (process.env.VOICEBOX_PROVIDER) {
    console.log(`  NOTE    VOICEBOX_PROVIDER is set — it is the OLD single name. Resolver is now`);
    console.log(`          VOICEBOX_RESOLVER and transport is VOICEBOX_LIVE_PROVIDER; they are`);
    console.log(`          different concepts and this name selects the RESOLVER.`);
  }

  console.log(`
NETWORK
`);
  line("PORT", "8787", "the API and static host");
  line("VOICEBOX_HELLO_BOUND_MS", "(default)", "entitlement handshake bound");
  line("VOICEBOX_BIND_DEADLINE_MS", "(default)", "port-bind deadline");
  line("VOICEBOX_BIND_RETRY_MS", "(default)", "port-bind retry interval");

  console.log(`
CREDENTIALS — presence only, never a value
`);
  const key = (name, needed) => {
    const v = process.env[name];
    console.log(`  ${set(v) ? "SET    " : "unset  "}${name.padEnd(26)} ${set(v) ? `${String(v).length} chars` : "—"}  ${needed}`);
  };
  key("GEMINI_API_KEY", "needed by resolver=gemini and live provider gemini");
  key("OPENAI_API_KEY", "needed by live provider openai");

  const wantResolver = process.env.VOICEBOX_RESOLVER ?? process.env.VOICEBOX_PROVIDER ?? "script";
  const wantLive = process.env.VOICEBOX_LIVE_PROVIDER ?? process.env.LIVE_PROVIDER ?? "gemini";
  const missing = [];
  if (wantResolver === "gemini" && !set(process.env.GEMINI_API_KEY)) missing.push("resolver=gemini needs GEMINI_API_KEY");
  if (wantLive === "gemini" && !set(process.env.GEMINI_API_KEY)) missing.push("live=gemini needs GEMINI_API_KEY");
  if (wantLive === "openai" && !set(process.env.OPENAI_API_KEY)) missing.push("live=openai needs OPENAI_API_KEY");

  console.log(`
VERDICT`);
  console.log(`  turn brain        ${wantResolver}`);
  console.log(`  live transport    ${wantLive}`);
  const wantHarness = process.env.VOICEBOX_HARNESS ?? "(none)";
  const harnessVerdict = (wantHarness === "pi" || wantHarness === "pi-acp")
    ? "pi (admitted via pi-acp)"
    : wantHarness === "claude"
    ? "claude (unrunnable: no Voicebox task adapter is configured for this CLI)"
    : wantHarness === "(none)"
    ? "none admitted (set VOICEBOX_HARNESS=pi to admit Pi)"
    : `${wantHarness} (unsupported)`;
  console.log(`  task harness      ${harnessVerdict}`);
  console.log(`  root at boot      ${workspaceDeclared() ?? "none — declare one from the page, or set VOICEBOX_WORKSPACE"}`);
  if (missing.length === 0) {
    console.log(`  credentials       present for what is selected`);
  } else {
    for (const m of missing) console.log(`  MISSING           ${m}`);
  }

  // WHAT IT ACTUALLY ANSWERS, because "set" is not "working": a running server is
  // the only place the declared root is visible, and the root is what every write
  // depends on. Read-only; it touches nothing.
  const port = Number(process.env.PORT ?? 8787);
  const get = async (u) => {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(1500) });
      return await r.json();
    } catch { return null; }
  };
  const health = await get(`http://127.0.0.1:${port}/api/health`);
  console.log(`
A SERVER ON :${port}`);
  if (!health) {
    console.log(`  not answering — start it with: npm run serve`);
  } else {
    const root = await get(`http://127.0.0.1:${port}/api/root`);
    console.log(`  answering         yes`);
    if (root && root.declared) {
      console.log(`  root              ${root.project} at ${root.root?.path}  (${root.root?.kind})`);
    } else {
      console.log(`  root              NONE DECLARED — every write refuses with "root-not-declared"`);
      console.log(`                    if that is not what you want: POST /api/root, or restart with`);
      console.log(`                    VOICEBOX_WORKSPACE=/path npm run serve`);
    }
  }
  console.log("");
  process.exit(0);
}

// `--help` DONE PROPERLY, because the options were only discoverable by reading this
// file: every one of them is an environment variable, and nothing said so. (Paul,
// 2026-09-23: "I can't work out how to add a root or change the provider".)
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
voicebox server — the local project, its files and its live voice.

  npm run serve                     start on :8787 (reloads when a source file changes)
  npm run serve -- --help           this text

A ROOT is the folder voicebox can read and write. There are three ways to get one:

  1. From the page      the explorer's declare control (POST /api/root)
  2. At boot            VOICEBOX_WORKSPACE=/path/to/folder npm run serve
  3. From a worker      the browser worker declares one when it opens a project

Without one, every write refuses with "root-not-declared" — that is the refusal
naming its own remedy, not a fault.

THE TURN BRAIN decides who answers a typed turn, and is chosen at boot:

  VOICEBOX_RESOLVER=gemini          the Gemini text model
  VOICEBOX_RESOLVER=script          the scripted provider (no key, deterministic)

THE LIVE TRANSPORT is separate — it decides who carries spoken voice:

  VOICEBOX_LIVE_PROVIDER=gemini | openai

THE TASK HARNESS executes async background tasks (delegate_task):

  VOICEBOX_HARNESS=pi               the Pi coding agent via pi-acp adapter

Both are per-process: there is no first-class settings file yet, so a change means
a restart. (The agent-settings surface covers voice and instructions for a running
session; the resolver and transport are boot choices.)

OTHER VARIABLES

  PORT                        default ${process.env.PORT ?? 8787}
  VOICEBOX_INSTANCE           this instance's name        default "machine"
  VOICEBOX_HARNESS            task harness (pi)
  VOICEBOX_EXTENSIONS_DIR     where extensions live      default <repo>/extensions
  VOICEBOX_SANDBOX_HOMES      sandbox home root
  VOICEBOX_HELLO_BOUND_MS     entitlement handshake bound
  VOICEBOX_BIND_DEADLINE_MS   port-bind deadline
  VOICEBOX_BIND_RETRY_MS      port-bind retry interval

A note on the word "provider": VOICEBOX_RESOLVER selects the turn brain and
VOICEBOX_LIVE_PROVIDER selects the live transport. They are different concepts.
The old single name VOICEBOX_PROVIDER is still honoured, out loud, with a warning.
`);
  process.exit(0);
}

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
  // --quiet --verify: the IDIOMATIC existence test for a ref. Without them, `git rev-parse` prints
  // "fatal: Needed a single revision" to stderr on EVERY call in a worktree whose branch has no upstream
  // — which is every lane worktree before its first push, so the line appeared in server logs and in a
  // test's captured stderr next to unrelated failures (voicebox-beads-8js). Same result, no noise: exit 1
  // and empty stderr when the ref is absent, which the default below already handles.
  const remote = git(["rev-parse", "--quiet", "--verify", "--short", `origin/${branch}`], "");
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
  // Read the registry at call time, not live-session setup: approval can happen mid-conversation.
  if (action.verb === "extensions") return { ok: true, ...extensions.inventory() };
  if (action.verb === "extension") return extensions.callTool(action.name, action.args ?? {});
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
  if (action.verb === "mini_app") {
    const appId = `app_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    const miniApp = {
      appId,
      title: action.title || "Interactive App",
      html: action.html || "<!doctype html><html><body></body></html>",
    };
    try { pageSocket?.send(JSON.stringify({ type: "mini_app", miniApp })); } catch {}
    try { runningSession?.socket?.send(JSON.stringify({ type: "mini_app", miniApp })); } catch {}
    return {
      ok: true,
      action: `launched mini-app "${miniApp.title}" (${appId})`,
      miniApp,
      root: active?.root ?? null,
    };
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
  if (action.verb === "grep") {
    const query = String(action.query ?? action.name ?? "").trim();
    if (!query) {
      return { ok: false, refused: "missing-argument", error: "refused: missing-argument", why: "grep requires a search query", root: active.root };
    }
    const matches = [];
    const MAX_MATCHES = 100;
    const MAX_FILE_BYTES = 524288;
    function scanDir(dir, relDir = "") {
      if (matches.length >= MAX_MATCHES) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (matches.length >= MAX_MATCHES) break;
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const fullPath = path.join(dir, ent.name);
        const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (ent.isFile()) {
          try {
            const stat = statSync(fullPath);
            if (stat.size > MAX_FILE_BYTES) continue;
            const text = readFileSync(fullPath, "utf8");
            const lines = text.split("\n");
            for (let idx = 0; idx < lines.length; idx++) {
              if (matches.length >= MAX_MATCHES) break;
              const line = lines[idx];
              if (line.toLowerCase().includes(query.toLowerCase())) {
                matches.push({ file: relPath, line: idx + 1, text: line.slice(0, 300) });
              }
            }
          } catch {}
        }
      }
    }
    scanDir(active.root.path);
    const entry = logAct({ kind: "grep", target: query, tool: "turn" }, "allow", "greps-inside", "ok", { count: matches.length }, action.turn ?? null);
    return {
      ok: true,
      action: `grep "${query}" (${matches.length} matches)`,
      query,
      matches,
      count: matches.length,
      truncated: matches.length >= MAX_MATCHES,
      root: active.root,
      logged: entry ? entry.seq : null,
    };
  }
  if (action.verb === "list_agents") {
    const fleetAgents = await fleetManager.listAgents({ environmentKey: action.environment });
    const agents = fleetAgents.map(publicFleetProjection);
    return {
      ok: true,
      action: `listed ${agents.length} agent(s)`,
      agents,
      count: agents.length,
      root: active?.root ?? null,
    };
  }
  if (action.verb === "contact_agent") {
    const authority = {
      owner: createHash("sha256").update(`voicebox-fleet-contact\0${SELF_ENVIRONMENT}`).digest("hex"),
      callId: `contact_${Date.now().toString(36)}`,
    };
    const res = await fleetManager.contact({
      target: action.target,
      message: action.message,
      sessionId: action.sessionId,
      authority,
    });
    if (!res.ok) {
      return {
        ok: false,
        refused: res.refused,
        why: res.why,
        error: `refused: ${res.refused}`,
        root: active?.root ?? null,
      };
    }
    return {
      ok: true,
      action: `contacted ${res.targetKey || action.target}`,
      ...res,
      root: active?.root ?? null,
    };
  }
  if (action.verb === "delegate_task") {
    if (!active) {
      return {
        ok: false,
        refused: "task-root-unavailable",
        why: "delegating a task requires an active project root",
        error: "refused: task-root-unavailable",
        root: null,
      };
    }
    const requested = action.agent ?? "default";
    const target = parseTargetKey(requested, SELF_ENVIRONMENT);

    if (target.environmentKey !== SELF_ENVIRONMENT) {
      const fleet = await fleetManager.listAgents();
      const resolution = resolveFleetTarget(target, fleet, SELF_ENVIRONMENT);
      if (!resolution.ok) {
        return {
          ok: false,
          refused: resolution.refused,
          why: resolution.why,
          error: `refused: ${resolution.refused}`,
          root: active.root,
        };
      }
      return {
        ok: false,
        refused: "cross-environment-unauthorized",
        why: `Calling agent '${formatTargetKey(target)}' in remote environment '${target.environmentKey}' requires pairing credentials`,
        error: "refused: cross-environment-unauthorized",
        root: active.root,
      };
    }

    const authority = {
      owner: createHash("sha256").update(`voicebox-task-owner\0${SELF_ENVIRONMENT}\0local`).digest("hex"),
      callId: `turn_${randomBytes(12).toString("hex")}`,
    };
    const admitted = tasks.call("delegate_task", {
      agent: target.agentId,
      task: action.task ?? "",
    }, authority);
    if (!admitted.ok) {
      return {
        ok: false,
        refused: admitted.refused,
        why: admitted.why,
        error: `refused: ${admitted.refused}`,
        root: active.root,
      };
    }
    try { pageSocket?.send(JSON.stringify({ type: "task", task: admitted.task })); } catch {}
    try { runningSession?.socket?.send(JSON.stringify({ type: "task", task: admitted.task })); } catch {}
    return {
      ok: true,
      action: `delegated task to ${admitted.task.agent} (${admitted.task.address})`,
      task: admitted.task,
      address: admitted.task.address,
      agent: admitted.task.agent,
      root: active.root,
    };
  }
  const name = String(action.name ?? "");
  if (!name) return { ok: false, error: "action has no name" };
  const resolved = resolveActive(name);
  if (!resolved.ok) {
    // A refusal is recorded as well: the log answers "what did it try", not only "what did it do".
    const kind = ["read", "diff"].includes(action.verb) ? action.verb : ["write", "edit", "delete"].includes(action.verb) ? action.verb : "read";
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
  if (["read", "write", "delete", "edit", "diff"].includes(action.verb)) {
    const base = path.basename(resolved.path);
    if (base.startsWith(".")) {
      const kind = ["read", "diff"].includes(action.verb) ? action.verb : ["write", "edit", "delete"].includes(action.verb) ? action.verb : "write";
      const entry = logAct({ kind, target: name, tool: "turn" }, "refuse", "dotfile-refused", "refused", null, action.turn ?? null);
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
  if (action.verb === "delete") {
    if (!existsSync(candidate)) {
      const entry = logAct({ kind: "delete", target: name, tool: "turn" }, "refuse", "not-found", "refused", null, action.turn ?? null);
      return { ok: false, refused: "not-found", logged: entry ? entry.seq : null, error: "refused: not-found", why: `'${name}' is not in ${active.project}`, root: active.root };
    }
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const entry = logAct({ kind: "delete", target: name, tool: "turn" }, "refuse", "cannot-delete-directory", "refused", null, action.turn ?? null);
      return { ok: false, refused: "cannot-delete-directory", logged: entry ? entry.seq : null, error: "refused: cannot-delete-directory", why: `'${name}' is a directory; delete applies to files`, root: active.root };
    }
    unlinkSync(candidate);
    const entry = logAct({ kind: "delete", target: name, tool: "turn" }, "allow", "deletes-inside", "ok", observeUnderRoot(name), action.turn ?? null, [{ path: name, bytes: stat.size }]);
    return {
      ok: true,
      action: `deleted ${name}`,
      file: name,
      root: active.root,
      logged: entry ? entry.seq : null,
      auditLocation: `${active.root.path}/.audit/`,
    };
  }
  if (action.verb === "edit") {
    if (!existsSync(candidate)) {
      const entry = logAct({ kind: "edit", target: name, tool: "turn" }, "refuse", "not-found", "refused", null, action.turn ?? null);
      return { ok: false, refused: "not-found", logged: entry ? entry.seq : null, error: "refused: not-found", why: `'${name}' is not in ${active.project}`, root: active.root };
    }
    if (action.oldText == null || action.newText == null) {
      const entry = logAct({ kind: "edit", target: name, tool: "turn" }, "refuse", "missing-argument", "refused", null, action.turn ?? null);
      return { ok: false, refused: "missing-argument", logged: entry ? entry.seq : null, error: "refused: missing-argument", why: "edit requires both 'oldText' and 'newText'", root: active.root };
    }
    const original = readFileSync(candidate, "utf8");
    if (!original.includes(action.oldText)) {
      const entry = logAct({ kind: "edit", target: name, tool: "turn" }, "refuse", "pattern-not-found", "refused", null, action.turn ?? null);
      return { ok: false, refused: "pattern-not-found", logged: entry ? entry.seq : null, error: "refused: pattern-not-found", why: `could not find exact text match for oldText in '${name}'`, root: active.root };
    }
    const firstIdx = original.indexOf(action.oldText);
    const lastIdx = original.lastIndexOf(action.oldText);
    if (firstIdx !== lastIdx) {
      const entry = logAct({ kind: "edit", target: name, tool: "turn" }, "refuse", "pattern-not-unique", "refused", null, action.turn ?? null);
      return { ok: false, refused: "pattern-not-unique", logged: entry ? entry.seq : null, error: "refused: pattern-not-unique", why: `found multiple occurrences of oldText in '${name}' — specify a unique text block`, root: active.root };
    }
    const updated = original.slice(0, firstIdx) + action.newText + original.slice(firstIdx + action.oldText.length);
    writeFileSync(candidate, updated, "utf8");
    const entry = logAct({ kind: "edit", target: name, tool: "turn" }, "allow", "edits-inside", "ok", observeUnderRoot(name), action.turn ?? null, [{ path: name, bytes: Buffer.byteLength(updated) }]);
    return {
      ok: true,
      action: `edited ${name} (${Buffer.byteLength(updated)} bytes)`,
      file: name,
      bytes: Buffer.byteLength(updated),
      root: active.root,
      logged: entry ? entry.seq : null,
      auditLocation: `${active.root.path}/.audit/`,
    };
  }
  if (action.verb === "diff") {
    let current = "";
    if (existsSync(candidate)) {
      try { current = readFileSync(candidate, "utf8"); } catch {}
    }
    const proposed = typeof action.content === "string" ? action.content : "";
    const unifiedDiff = createUnifiedDiff(name, current, proposed);
    const entry = logAct({ kind: "diff", target: name, tool: "turn" }, "allow", "diffs-inside", "ok", observeUnderRoot(name), action.turn ?? null);
    return {
      ok: true,
      action: `diff ${name}`,
      file: name,
      diff: unifiedDiff,
      changed: current !== proposed,
      root: active.root,
      logged: entry ? entry.seq : null,
    };
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

const harnessInventory = createHarnessInventory();
const routes = {
  "GET /api/agents": (req, res, url) => {
    const environmentKey = url.searchParams.get("environment") || undefined;
    const harness = url.searchParams.get("harness") || undefined;
    const agents = agentRegistry.list({ environmentKey, harness }).map(publicAgentProjection);
    return json(res, 200, { ok: true, agents });
  },
  "GET /api/fleet": async (req, res, url) => {
    const environmentKey = url.searchParams.get("environment") || undefined;
    const harness = url.searchParams.get("harness") || undefined;
    const fleet = await fleetManager.listAgents({ environmentKey, harness });
    return json(res, 200, { ok: true, fleet: fleet.map(publicFleetProjection) });
  },
  "POST /api/fleet/contact": (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => answerOnce(res, async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
      }
      const authority = {
        owner: createHash("sha256").update(`voicebox-fleet-contact\0${SELF_ENVIRONMENT}`).digest("hex"),
        callId: `contact_${Date.now().toString(36)}`,
      };
      const resContact = await fleetManager.contact({
        target: parsed.target,
        message: parsed.message,
        sessionId: parsed.sessionId,
        authority,
        auth: { bearer: req.headers["authorization"]?.replace(/^Bearer\s+/i, "") },
      });
      const status = resContact.ok ? 200 : (["cross-environment-unauthorized", "environment-not-paired"].includes(resContact.refused) ? 403 : 400);
      return json(res, status, resContact);
    }));
  },
  "GET /api/harnesses": async (req, res) => {
    const inv = await harnessInventory();
    const combined = await listHarnessesWithConfiguredAgents(inv, agentRegistry);
    return json(res, 200, combined);
  },
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
  "GET /api/changelog": (req, res, url) => {
    try {
      const raw = execFileSync("git", ["log", "-n", "30", "--pretty=format:%H\t%h\t%s\t%an\t%aI\t%as"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const commits = raw.trim().split("\n").filter(Boolean).map((line) => {
        const [sha, shortSha, subject, author, isoDate, date] = line.split("\t");
        return {
          sha,
          shortSha,
          subject,
          author,
          date,
          url: `https://github.com/PaulKinlan/voicebox/commit/${sha}`,
        };
      });
      return json(res, 200, { ok: true, repo: "https://github.com/PaulKinlan/voicebox", commits });
    } catch (e) {
      return json(res, 500, { ok: false, error: e?.message ?? String(e), repo: "https://github.com/PaulKinlan/voicebox", commits: [] });
    }
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
    // THE BOOTSTRAP DOOR (docs/13 §4, opt-in): a valid one-time ticket is exchanged for the
    // session cookie on this very response, so the page the person asked for is the page they
    // get — no second navigation. An invalid or already-consumed ticket is a NAMED refusal with
    // the remedy in it, because a ticket that silently 404s would read as the server being broken.
    const bootstrapHeaders = {};
    if (LOOPBACK_AUTH && url.searchParams.has("bootstrap")) {
      if (!consumeBootstrapTicket(url.searchParams.get("bootstrap"))) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        return res.end(
          "401 bootstrap-ticket-refused — that bootstrap ticket is unknown or already used; one ticket opens one session. " +
            "Open the bootstrap URL the server printed when it started, or mint a fresh one: " +
            "POST /api/bootstrap with the x-voicebox-host-token header.",
        );
      }
      bootstrapHeaders["set-cookie"] = `${SESSION_COOKIE}=${LOOPBACK_SESSION}; HttpOnly; SameSite=Strict; Path=/`;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...bootstrapHeaders });
    const where = BUILD.ahead === null
      ? ` · no origin/${BUILD.branch} here, so the distance from a remote is unknown`
      : BUILD.ahead === 0
      ? ""
      : ` · ${BUILD.ahead} commit${BUILD.ahead === 1 ? "" : "s"} ahead of origin/${BUILD.branch} (not landed)`;
    const stamp = `${BUILD.branch} @ ${BUILD.commit}${where}${BUILD.dirty ? " · uncommitted changes" : ""}`;
    const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8")
      .replace("__VOICEBOX_BUILD_STAMP__", stamp)
      .replace("__VOICEBOX_SESSION_TOKEN__", ROOM_SESSION_TOKEN);
    res.end(html);
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
  const readJson = (maxBytes = Infinity) => new Promise((resolve) => {
    let body = "", bytes = 0;
    req.on("data", (c) => { bytes += c.length; if (bytes <= maxBytes) body += c; });
    req.on("end", () => { try { resolve(bytes > maxBytes ? null : JSON.parse(body || "{}")); } catch { resolve(null); } });
  });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  // THE WALL (opt-in, docs/13 §4): with the gate on, an unauthenticated request gets a named
  // refusal and a remedy, before any route — including the static fallthrough below — answers.
  // Self-authorising exemptions, each with its reason named:
  //   · /api/health — the spawn-and-wait harness, supervisors and the currency gate heartbeat
  //     read it before any session exists; it reports no root, no file and no credential.
  //   · POST /api/bootstrap — it IS the authority check (host token) and the re-entry door.
  //   · the page carrying ?bootstrap= — the route itself validates and consumes the ticket.
  // The WebSocket upgrades (/channel, /live) do not pass through here: their local-page
  // entitlement checks the session cookie in place, and every other peer still answers the
  // pairing-bearer hello exactly as 5c1 built it.
  if (LOOPBACK_AUTH && !sessionCookieOk(req)) {
    const pageBootstrapping =
      (url.pathname === "/" || url.pathname === "/index.html") && url.searchParams.has("bootstrap");
    // The HOST TOKEN also passes the wall: it is the 0600 authority the person's shell already
    // holds (admission, root declaration, pairing) — a process that can read it is inside the host
    // boundary by definition (docs/13 §4), and the host's own acts must not need a browser.
    const exempt =
      url.pathname === "/api/health" ||
      (req.method === "POST" && url.pathname === "/api/bootstrap") ||
      pageBootstrapping ||
      extensions.hostTokenOk(req.headers["x-voicebox-host-token"]);
    if (!exempt) {
      const why =
        "this server was started with VOICEBOX_LOOPBACK_AUTH=1: open the bootstrap URL it printed at startup " +
        "(one-time), or mint a fresh ticket with POST /api/bootstrap and the x-voicebox-host-token header. " +
        "Requests carrying the host token pass directly. Everything else answers only with the session " +
        "cookie that the bootstrap exchange mints.";
      if (url.pathname.startsWith("/api/")) {
        return json(res, 401, { ok: false, refused: "loopback-unauthenticated", why });
      }
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`401 loopback-unauthenticated — ${why}`);
    }
  }
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
    // DECLARING A ROOT IS THE HOST'S ACT — for a root the HOST can act on. The authority is the same
    // class as admitting an extension or issuing a pairing bearer, and the same mechanism as both
    // (voicebox-beads-m2i): a host-generated secret, mode 0600, in the host's own directory, served by
    // no route — the person's shell has it. A machine root needs it because that route re-points every
    // FILE route the server itself serves, so without the token anything that can reach the server
    // could aim the loop at anything the process can read.
    //
    // A PAGE-OWNED ROOT IS A DIFFERENT ACT, and the same token would defend nothing. The server cannot
    // act on an opfs or handle root at all (core/root.ts ROOT_FACTS.opfs.reachableFrom = ["page"]):
    // every act routes back to the page over /channel, and the page refuses any root that is not its own
    // (browser/acts.ts: root-not-mine) — so a declaration here grants no file-route power to anyone. The
    // page may therefore declare what only the page can act on, and the check is the SAME one /channel
    // already makes to decide who the local page is: the request's Origin is one of THIS server's own
    // bound origins. That is not any origin, and it is not a credential a stranger benefits from: a
    // page-owned declaration is inert for the server and answers only to the page that owns the files.
    //
    // This is the defect voicebox-beads-fqq names: the page could not hold a token, so a browser-stored
    // project could never be declared, so a fresh room could not list or write anything at all.
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

      // Who is asking? The token decides for a machine root; the page's own origin decides for a root
      // only the page can act on. Both refusals name the rule they were refused by.
      const pageOwned = root.kind === "opfs" || root.kind === "handle";
      const declaredByHost = extensions.hostTokenOk(req.headers["x-voicebox-host-token"]);
      const selfPort = boundPort ?? PORT;
      const ownOrigins = new Set([
        `http://127.0.0.1:${selfPort}`,
        `http://localhost:${selfPort}`,
        `http://[::1]:${selfPort}`,
      ]);
      const fromOwnPage = typeof req.headers.origin === "string" && ownOrigins.has(req.headers.origin);
      if (!declaredByHost && !(pageOwned && fromOwnPage)) {
        return json(res, 403, {
          ok: false,
          refused: "host-token-required",
          why: pageOwned
            ? "declaring a page-owned root needs either the host token (x-voicebox-host-token) or a request from this server's own origin — a browser-stored project is declared by the page that owns it, and this request came from somewhere else"
            : "declaring the project root is the host's act — it re-points every file route — and this route requires the host token (x-voicebox-host-token); the page cannot hold it, and the server cannot act on a page-owned root either way",
        });
      }
      const declaredBy = declaredByHost ? "host" : "page";

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
        // WHO declared it, so a reader can tell the host's act from the page's own (fqq): the room's
        // header and the page's line both say which of the two aimed this root.
        declaredBy,
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
    // WHICH FOLDER: `?dir=proposals/drafts` lists INSIDE the root instead of listing the root itself
    // (voicebox-beads-tee). The path arrives from a person clicking a folder, so it is normalised and
    // bounded here — one shared helper, so the page and the server cannot disagree about what
    // `proposals/../..` means — and every refusal is named rather than quietly rewritten.
    const wanted = normaliseRelativeDir(url.searchParams.get("dir") ?? "");
    if (!wanted.ok) {
      return json(res, 200, { ok: false, refused: wanted.refused, why: wanted.why, dir: "", parent: null, files: [], entries: [] });
    }
    const dir = wanted.dir;
    const here = { dir, parent: parentDir(dir) };
    // NO SERVER ROOT, BUT THE PAGE HOLDS A PROJECT: list it through the page (voicebox-beads-fqq).
    // This is the fresh-room case — nothing declared, nothing picked — where the page has made a
    // browser-stored project and the room must be able to see it. The server declares nothing here and
    // stores nothing: it relays one question to the only side that can answer it, and every field of
    // the answer says whose listing it is. A refusal is the page's own words, never a blank list.
    if (!active && pageExecutorConnected()) {
      const onPage = await askPage({ verb: "list", name: dir });
      const observed = onPage.observed ?? {};
      if (onPage.ok) {
        return json(res, 200, {
          ok: true,
          via: "page",
          declared: false,
          root: observed.root ?? { kind: "opfs" },
          project: null,
          ...here,
          files: observed.files ?? [],
          entries: observed.entries ?? [],
          truncated: observed.truncated ?? false,
        });
      }
      // The page is connected but has nothing to list (no project open): that is a NAMED state with a
      // route, not an empty folder — the room prints the sentence and the link.
      if (onPage.refused && onPage.refused !== "no-page") {
        return json(res, 200, { ok: false, refused: onPage.refused, why: onPage.why, via: "page", root: observed.root ?? null, ...here, files: [], entries: [] });
      }
    }
    // The listing follows the ACTIVE root: a listing from a root the loop cannot reach would be the
    // two-root bug in miniature — a panel showing files from somewhere the project is not.
    if (!active) return json(res, 200, { ...noRootDeclared(), root: null, ...here, files: [], entries: [] });
    const vanishedFiles = rootMissing();
    if (vanishedFiles) return json(res, 200, { ...vanishedFiles, root: active.root, ...here, files: [], entries: [] });
    // A page-owned root lists through the page (core/dispatch.ts): the room sees the same
    // files whichever root kind the project is on, and the answer says whose listing it is.
    if (dispatchFor(active.root, SELF_ENVIRONMENT).executeOn === "page") {
      const answer = await askPage({ verb: "list", name: dir });
      if (!answer.ok) return json(res, 200, { ok: false, refused: answer.refused, why: answer.why, via: "page", root: active.root, ...here, files: [], entries: [] });
      const observed = answer.observed ?? {};
      return json(res, 200, { ok: true, via: "page", root: active.root, project: active.project, ...here, files: observed.files ?? [], entries: observed.entries ?? [], truncated: observed.truncated ?? false });
    }
    const reach = reachableFromEnvironment(active.root, { peer: "machine", environment: SELF_ENVIRONMENT });
    if (!reach.ok) {
      return json(res, 200, { ok: false, refused: reach.refused, why: reach.why, root: active.root, ...here, files: [], entries: [] });
    }
    // THE FOLDER ITSELF, through the SAME containment gate the file routes use: `..` escapes, a real-path
    // escape (a symlink), and the host-owned audit are all refused by name, so navigating down cannot
    // reach somewhere reading a file could not.
    // The ROOT is the one path that needs no resolution — it IS the root. Passing '.' to the shared
    // resolver made it name a file and list the root as `outside-root` (found by driving: the root listing
    // refused itself), so the empty path is answered directly and only subfolders go through the gate.
    const target = dir === "" ? { ok: true, path: active.root.path } : resolveActive(dir);
    if (!target.ok) {
      return json(res, 200, { ok: false, refused: target.refused, why: target.why, root: active.root, ...here, files: [], entries: [] });
    }
    let dirents;
    try {
      dirents = readdirSync(target.path, { withFileTypes: true });
    } catch (e) {
      const code = e?.code ?? "error";
      return json(res, 200, {
        ok: false,
        refused: code === "ENOENT" ? "folder-missing" : code === "ENOTDIR" ? "not-a-folder" : "folder-unreadable",
        why: code === "ENOENT"
          ? `'${dir}' is not there any more — it may have been renamed or removed since the listing you clicked`
          : code === "ENOTDIR"
            ? `'${dir}' is a file, not a folder`
            : `'${dir}' could not be listed: ${e?.message ?? e}`,
        root: active.root,
        ...here,
        files: [],
        entries: [],
      });
    }
    const visible = dirents.filter((entry) => !entry.name.startsWith("."));
    const entries = visible.map((entry) => {
      try {
        const stat = statSync(path.join(target.path, entry.name));
        return { name: entry.name, bytes: stat.size, kind: stat.isDirectory() ? "directory" : "file" };
      } catch {
        return { name: entry.name, bytes: 0, kind: entry.isDirectory() ? "directory" : "file" };
      }
    });
    return json(res, 200, { ok: true, root: active.root, project: active.project, ...here, files: entries.map((e) => e.name), entries });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const name = url.searchParams.get("name") ?? "";
    if (!name) return json(res, 400, { error: "action has no name" });
    // NO SERVER ROOT, BUT THE PAGE HOLDS A PROJECT: read through the page, the same way the listing
    // above does (voicebox-beads-fqq) — a listing whose files cannot be opened is half an answer.
    if (!active && pageExecutorConnected()) {
      const onPage = await askPage({ verb: "read", name });
      if (onPage.ok) {
        const observed = onPage.observed ?? {};
        return json(res, 200, { ok: true, via: "page", declared: false, name, content: observed.content ?? "", bytes: observed.bytes ?? 0, root: observed.root ?? null });
      }
      if (onPage.refused && onPage.refused !== "no-page") {
        return json(res, onPage.refused === "not-found" ? 404 : 409, { ok: false, refused: onPage.refused, error: `refused: ${onPage.refused}`, why: onPage.why, via: "page" });
      }
    }
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

  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const name = url.searchParams.get("name") ?? "";
    const result = await execute({ verb: "delete", name });
    if (!result.ok) return json(res, result.refused === "not-found" ? 404 : 400, result);
    return json(res, 200, result);
  }

  if (req.method === "PATCH" && url.pathname === "/api/file") {
    const body = await readJson();
    const result = await execute({ verb: "edit", name: body?.name, oldText: body?.oldText, newText: body?.newText });
    if (!result.ok) return json(res, result.refused === "not-found" ? 404 : 400, result);
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/file/diff") {
    const body = await readJson();
    const result = await execute({ verb: "diff", name: body?.name, content: body?.content });
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/grep") {
    const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
    const result = await execute({ verb: "grep", query });
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/delegate") {
    const body = await readJson();
    const result = await execute({ verb: "delegate_task", agent: body?.agent, task: body?.task });
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/task") {
    const address = url.searchParams.get("address") ?? "";
    const authority = {
      owner: createHash("sha256").update(`voicebox-task-owner\0${SELF_ENVIRONMENT}\0local`).digest("hex"),
      callId: `status_${randomBytes(8).toString("hex")}`,
    };
    const resStatus = tasks.call("task_status", { address }, authority);
    if (!resStatus.ok) return json(res, 404, resStatus);
    return json(res, 200, resStatus);
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
      if (parsed.fence === true || parsed.fence === "l15") {
        // fence:true boots the L1 bwrap fence; fence:"l15" boots the L1.5 composition — a transient
        // systemd --user unit whose Exec is the fence (voicebox-beads-8ny). Same declare-and-boot,
        // same rule: the boundary the row carries is measured by the environment's own probe.
        const booted = parsed.fence === "l15" ? await bootUnitFence(candidate.value) : await bootFence(candidate.value);
        if (!booted.ok) return json(res, 502, { ok: false, refused: booted.refused, why: booted.why });
        if (parsed.fence === "l15") bootedUnitKeys.add(candidate.value.key);
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
      const executionResult = await execute(action);
      const responsePayload = { transcript, action, result: executionResult };
      if (executionResult?.task) {
        responsePayload.task = executionResult.task;
      }
      if (executionResult?.miniApp) {
        responsePayload.miniApp = executionResult.miniApp;
      }
      return json(res, 200, responsePayload);
    }));
    return;
  }

  // ── the extension surface (N17): discover, inventory, sideload ──────────
  // The disclosure sits between the verbs: every confirm-first act returns
  // the RESOLVED PLAN — the extension's source, what it declares, what will
  // be enforced and by which mechanism, what it cannot have — before the act
  // runs. The page (astra's bead) renders this; the API is the surface.

  if (req.method === "POST" && url.pathname === "/api/agents") {
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, {
        ok: false,
        refused: "host-token-required",
        why: "configuring an agent is the host's act and requires the host token (x-voicebox-host-token); the page cannot hold it",
      });
    }
    const body = await readJson();
    const registered = agentRegistry.register(body);
    if (!registered.ok) return json(res, 400, registered);
    return json(res, 201, { ok: true, agent: publicAgentProjection(registered.agent) });
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "PATCH" && agentMatch) {
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, {
        ok: false,
        refused: "host-token-required",
        why: "updating an agent is the host's act and requires the host token (x-voicebox-host-token); the page cannot hold it",
      });
    }
    const agentId = agentMatch[1];
    const body = await readJson();
    if (typeof body?.name === "string" && Object.keys(body).length === 1) {
      const renamed = agentRegistry.rename(agentId, body.name);
      if (!renamed.ok) return json(res, renamed.refused === "agent-not-found" ? 404 : 400, renamed);
      return json(res, 200, { ok: true, agent: publicAgentProjection(renamed.agent) });
    }
    const updated = agentRegistry.update(agentId, body);
    if (!updated.ok) return json(res, updated.refused === "agent-not-found" ? 404 : 400, updated);
    return json(res, 200, { ok: true, agent: publicAgentProjection(updated.agent) });
  }

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
  if (req.method === "POST" && ["/api/extensions/local", "/api/extensions/create"].includes(url.pathname)) {
    // Create and locally add new extensions (voicebox-beads-b1p).
    // Host-owned admission gate: staging creates a pending proposal with source "local".
    // Direct admission requires the host token (x-voicebox-host-token); without it, direct admission is refused.
    const body = await readJson();
    const descriptor = body?.descriptor ?? body;
    if (!descriptor || typeof descriptor !== "object") {
      return json(res, 400, { ok: false, refused: "bad-request", why: "extension descriptor object required" });
    }
    const wantsAdmit = Boolean(body?.admit);
    if (wantsAdmit) {
      if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
        return json(res, 403, { ok: false, refused: "host-token-required", why: "direct admission is the host's act — this requires the host token (x-voicebox-host-token); stage as proposal first" });
      }
      const r = extensions.createAndAdmitExtension(descriptor, "host");
      return json(res, r.ok ? 200 : 400, r);
    }
    const r = extensions.createExtension(descriptor, descriptor.source ?? "local");
    return json(res, r.ok ? 200 : 400, r);
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

  if (req.method === "POST" && url.pathname === "/api/extensions/revoke") {
    // REVOCATION is a protected act (voicebox-beads-qg1, voicebox-beads-5jl):
    // Authorized via in-room session token, local room origin, or the host token.
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "revocation is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { error: "body must be JSON with an id" });
    if (body.confirm !== true) {
      const inv = extensions.inventory();
      const row = inv.extensions.find((e) => e.id === body.id);
      if (!row) return json(res, 404, { ok: false, refused: "extension-not-admitted", why: `'${body.id}' is not a running extension — nothing to revoke` });
      return json(res, 200, { confirmFirst: true, id: body.id, plan: { enforced: row.enforced, gets: row.gets, bounds: row.bounds, tools: row.tools },
        whatStopsWorking: { tools: row.tools, may: row.gets, bounds: row.bounds }, note: "nothing decided — repeat with confirm:true to revoke; the extension's tools stop being callable at once" });
    }
    const r = extensions.revokeExtension(body.id, body.actor ?? "host");
    return json(res, r.ok ? 200 : 404, r);
  }

  // DELETE /api/extensions/:id (voicebox-beads-ud5, voicebox-beads-5jl) — REST revocation endpoint
  const deleteExtMatch = req.method === "DELETE" && url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)$/);
  if (deleteExtMatch) {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "revocation is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const id = deleteExtMatch[1];
    const r = extensions.revokeExtension(id, "host");
    return json(res, r.ok ? 200 : 404, r);
  }

  // POST /api/extensions/reconfigure (voicebox-beads-ud5, voicebox-beads-5jl) — confirm-first or apply reconfigured bounds
  if (req.method === "POST" && url.pathname === "/api/extensions/reconfigure") {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "reconfiguring an extension is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const body = await readJson();
    if (!body?.id) return json(res, 400, { ok: false, refused: "bad-request", why: "reconfiguration requires an extension id" });
    const inv = extensions.inventory();
    const row = inv.extensions.find((e) => e.id === body.id);
    if (!row) return json(res, 404, { ok: false, refused: "extension-not-admitted", why: `'${body.id}' is not a running extension — nothing to reconfigure` });

    if (body.bounds !== undefined) {
      if (typeof body.bounds !== "object" || body.bounds === null) {
        return json(res, 400, { ok: false, refused: "bounds-invalid", why: "bounds must be an object with parameters" });
      }
      if (body.bounds.maxRequests !== undefined) {
        const parsed = Number(body.bounds.maxRequests);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return json(res, 400, { ok: false, refused: "bounds-invalid", why: `maxRequests must be a non-negative integer (received ${body.bounds.maxRequests})` });
        }
      }
      if (body.bounds.maxBytes !== undefined) {
        const parsed = Number(body.bounds.maxBytes);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return json(res, 400, { ok: false, refused: "bounds-invalid", why: `maxBytes must be a non-negative integer (received ${body.bounds.maxBytes})` });
        }
      }
      if (body.bounds.hosts !== undefined && !Array.isArray(body.bounds.hosts) && typeof body.bounds.hosts !== "string") {
        return json(res, 400, { ok: false, refused: "bounds-invalid", why: "hosts must be an array of hostnames or a comma-separated string" });
      }
    }

    if (body.confirm !== true) {
      return json(res, 200, {
        confirmFirst: true,
        id: body.id,
        current: { bounds: row.bounds, declared: row.declared, tools: row.tools },
        proposed: { bounds: body.bounds ?? row.bounds },
        note: "nothing decided — repeat with confirm:true to apply reconfiguration",
      });
    }
    const r = extensions.reconfigureExtension(body.id, { bounds: body.bounds, tools: body.tools, params: body.params }, body.actor ?? "host");
    return json(res, r.ok ? 200 : 400, r);
  }

  // PATCH /api/extensions/:id (voicebox-beads-ud5, voicebox-beads-5jl) — REST reconfiguration endpoint
  const patchExtMatch = req.method === "PATCH" && url.pathname.match(/^\/api\/extensions\/([a-z0-9_-]+)$/);
  if (patchExtMatch) {
    if (!hasExtensionAuthority(req)) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "reconfiguring an extension is a protected host act — this route requires an authorized in-room session or host token (x-voicebox-host-token)" });
    }
    const id = patchExtMatch[1];
    const body = await readJson();
    const r = extensions.reconfigureExtension(id, { bounds: body?.bounds, tools: body?.tools, params: body?.params }, body?.actor ?? "host");
    return json(res, r.ok ? 200 : 400, r);
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

  // DELETE /api/environments/<key> (voicebox-beads-4kp): stop what you minted. A booted fence
  // unit is a systemd transient that outlives the process that asked for it by construction —
  // without this route every declare-and-boot leaks a unit, a port and its RSS until reboot.
  // Host-token gated (it stops a running environment); best-effort stop, then removal from the
  // stored list so the registry cannot claim a running environment it no longer has.
  const envDelete = url.pathname.match(/^\/api\/environments\/([^/]+)$/);
  if (req.method === "DELETE" && envDelete) {
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-required", why: "stopping a booted environment is a host act — supply the host token" });
    }
    const key = decodeURIComponent(envDelete[1]);
    await stopUnitFence(key);
    const stored = readEnvironments();
    if (stored.ok) {
      writeEnvironments(stored.environments.filter((e) => e.key !== key));
    }
    return json(res, 200, { ok: true, stopped: key });
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

  if (req.method === "POST" && url.pathname === "/api/bootstrap") {
    // MINTING A TICKET IS THE HOST'S ACT — the same 0600 authority as admission (m2i) and root
    // declaration (cfn). This is the re-entry door when the cookie is lost without a restart:
    // the person's shell holds the host token, so the remedy is one curl away. The ticket is
    // single-use like the startup one; the URL it names is this server's own bound address.
    if (!LOOPBACK_AUTH) {
      return json(res, 404, { ok: false, refused: "loopback-auth-disabled", why: "no bootstrap door exists when the server was not started with VOICEBOX_LOOPBACK_AUTH=1 — the page is served openly in that mode, which is the default" });
    }
    if (!extensions.hostTokenOk(req.headers["x-voicebox-host-token"])) {
      return json(res, 403, { ok: false, refused: "host-token-refused", why: "minting a bootstrap ticket requires the host token (x-voicebox-host-token) — the same authority that admits extensions and declares roots" });
    }
    const ticket = mintBootstrapTicket();
    return json(res, 200, { ok: true, url: `http://127.0.0.1:${boundPort ?? PORT}/?bootstrap=${ticket}` });
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
  // WHAT THIS DOES NOT PROTECT AGAINST — and what now closes it (docs/13 §4, opt-in):
  // A non-browser process on the local machine (curl, script) can forge an Origin header on raw loopback TCP.
  // By default that residual stays open (5c1's documented boundary). With VOICEBOX_LOOPBACK_AUTH=1 the local-page
  // entitlement ALSO requires the session cookie minted by the one-time bootstrap ticket, so a process that
  // cannot read the ticket output cannot take the chair by forging the header — it falls to the bearer-hello
  // path below and is refused there, by name. See the LOOPBACK SESSION AUTH block near the top of this file.
  if (url.pathname === "/channel") {
    const ws = wsUpgrade(req, socket);
    if (!ws) { socket.destroy(); return; }

    const selfPort = boundPort ?? PORT;
    const localOrigins = new Set([
      `http://127.0.0.1:${selfPort}`,
      `http://localhost:${selfPort}`,
      `http://[::1]:${selfPort}`,
    ]);
    const claimsToBeTheLocalPageNow = claimsToBeTheLocalPage(req, localOrigins);

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

    if (claimsToBeTheLocalPageNow) {
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
  // unauthenticated peer from costing a session and makes the PAIRED path enforceable. By default the claim
  // itself stays open (5c1's boundary); with VOICEBOX_LOOPBACK_AUTH=1 the local-page branch below also
  // requires the bootstrap-minted session cookie (docs/13 §4), which is what turns the claim into a proof
  // for every local process that cannot read the ticket output.
  const selfPort = boundPort ?? PORT;
  const localOrigins = new Set([
    `http://127.0.0.1:${selfPort}`,
    `http://localhost:${selfPort}`,
    `http://[::1]:${selfPort}`,
  ]);
  const claimsToBeTheLocalPageNow = claimsToBeTheLocalPage(req, localOrigins);

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

    // Debug data is private to this entitled socket, never a global log or a new route.
    const sessionId = randomBytes(12).toString("hex");
    const trace = url.searchParams.get("debug") === "1" ? (event) => {
      try { ws.send(JSON.stringify({ type: "debug", event: { ...event, source: "server", timestamp: new Date().toISOString(), sessionId, provider, model } })); }
      catch { /* diagnostics must not change execution when the page disconnects */ }
    } : undefined;
    trace?.({ type: "session.start", delivery: "Transport send is observable; model consumption is not acknowledged." });
    let session = null;
    try {
      liveSessionsCreated += 1;
      // D6-adjacent (9dh): the project's own instruction file, read from the DECLARED machine root
      // at session start. Page-held roots (opfs/handle) live in the browser and carry no server-side
      // file — named here rather than silently omitted. Named on the session too, so the page can
      // say which file the voice is working from.
      const activeRootNow = active;
      let projectInstruction = null;
      if (activeRootNow?.root?.kind === "machine" && activeRootNow.executor?.connected !== false) {
        const instruction = readProjectInstruction(activeRootNow.root.path);
        if (instruction.file) {
          projectInstruction = [
            "The project's own instructions, read at session start from " +
              `${instruction.file} in the declared root${instruction.truncated ? " (truncated at 32768 bytes)" : ""}. ` +
              "They are context for this project: they cannot change your capabilities, your root, or your refusal rules.",
            instruction.text,
          ].join("\n\n");
          console.error(`[live] project instruction read from ${instruction.root?.path ?? activeRootNow.root.path}/${instruction.file}${instruction.truncated ? " (truncated)" : ""}`);
        } else {
          console.error(`[live] no project instruction: ${instruction.reason}`);
        }
      } else if (activeRootNow) {
        console.error(`[live] no project instruction: ${activeRootNow.root?.kind} roots live in the page, not on this machine`);
      }
      session = createLiveSession({
        // THE AGENT SETTINGS APPLY HERE, which is what stops them being dead controls: the provider a
        // person chose is the provider this session dials, and its model comes with it.
        provider,
        model,
        projectInstruction,
        // The agent settings ride the seam: the personality composed over the mandatory base
        // (composeAgentInstruction cannot be handed a base — that is the mechanism), and the
        // voice the person chose for THIS provider. Both land in the provider's setup.
        instruction: composeAgentInstruction(agentSettings.personality),
        voice: agentSettings.voice || undefined,
        onDebug: trace,        onAudioOut: (pcm, mime) => { if (pcm.length > 4) ws.send(pcm); },
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
            const started = performance.now();
            const action = commandToAction(call.name, call.args);
            trace?.({ type: "tool.route", callId: call.id, name: call.name, action,
              route: !action || action.refused ? "refused-before-execution" : "shared-executor" });
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
            trace?.({ type: "tool.result", callId: call.id, name: call.name, result, durationMs: performance.now() - started,
              severity: result.ok === false ? "error" : "info" });
            if (result?.task) {
              try { ws.send(JSON.stringify({ type: "task", task: result.task })); } catch {}
            }
            if (result?.miniApp) {
              try { ws.send(JSON.stringify({ type: "mini_app", miniApp: result.miniApp })); } catch {}
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

  if (claimsToBeTheLocalPageNow) { beginSession(); return; }

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
  if (LOOPBACK_AUTH) {
    // The bootstrap URL is the ONLY way in while the gate is on (docs/13 §4): one-time ticket,
    // redeemed by the first browser that opens it into the session cookie. Printed, not written
    // to a file, for the same reason Jupyter prints its token: the terminal is the boundary.
    const ticket = mintBootstrapTicket();
    console.log(`bootstrap  http://127.0.0.1:${bound}/?bootstrap=${ticket}`);
    console.log(`  the page and every API/WS route answer only with the session cookie that URL mints (one-time; HttpOnly; SameSite=Strict).`);
    console.log(`  lost the cookie? mint another without restarting: curl -X POST -H "x-voicebox-host-token: $(cat "${HOST_DIR}/.host-token")" http://127.0.0.1:${bound}/api/bootstrap`);
  }
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
