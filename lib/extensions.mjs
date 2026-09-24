// lib/extensions.mjs — the extension system around the pure gate.
//
// WHO OWNS WHAT (bead voicebox-beads-bxx): the model's only door is a
// PROPOSAL — an ordinary tier 1 write into workspace/proposals/ (inside its
// root, reported, revertible). The HOST owns everything else: the extension
// directory (extensions/, outside the workspace root, unreachable by the
// model's containment), the admission decision, and the registry rebuild —
// which is the reload. There is no model-reachable register or reload: the
// resolver's verbs are make-tool (propose) and tool (call an admitted tool),
// and nothing else touches the loaded set.
//
// The runtime hands admitted tools INTERFACES, never ambient authority: the
// IO primitives resolve inside the project root or refuse, and the network
// primitive is a mediated fetch that refuses unlisted hosts and counts the
// budget. A declared capability is not an enforced one — the enforcement is
// the mediation, and it lives here, not in the descriptor.
//
// Zero dependencies: node: builtins only, plus the pure gate in core/.
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, renameSync, existsSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { admit, PRIMITIVE_NEEDS } from "../core/extensions.ts";
import { callWasmTool } from "./wasm-shelf.mjs";
import { makeEntry } from "../core/audit.ts";
import { createExtensionApprovals } from "./extension-approval.mjs";
import { protectedAuditPath, TASK_TOOLS } from "./tasks.mjs";

const REPO = path.dirname(fileURLToPath(import.meta.url)) + "/..";
// State directories are movable so a TEST HARNESS can point them at a scratch
// directory — a test must never delete a directory the repository or a real
// deployment owns (review finding, isocan-flash 2026-09-19: the suite's
// before-hook rm -rf'd the host extension directory to rebuild it; a crash
// between those moments is the untracked-work class). CATALOGUE stays
// repo-relative: it is tracked SOURCE, and the system only reads it.
const WORKSPACE = process.env.VOICEBOX_WORKSPACE ?? path.join(REPO, "workspace");
const PROPOSALS_DIR = path.join(WORKSPACE, "proposals"); // the model's door — inside its root
const EXTENSIONS_DIR = process.env.VOICEBOX_EXTENSIONS_DIR ?? path.join(REPO, "extensions"); // the host's directory — outside the root
const CATALOGUE_DIR = path.join(REPO, "catalogue"); // strangers' extensions, discover + sideload
const AUDIT_FILE = path.join(WORKSPACE, "audit.jsonl");

// ── THE ROOT THE TOOLS ACT IN (voicebox-beads-gto, qwen2's driven finding) ──
// The defect: this module resolved WORKSPACE at import time and never saw the
// DECLARED root, so an admitted tool acted in a different place from the one
// the root declaration names — a second answer to "where does this write?",
// and the two disagreed. The host hands the answer down, and it can CHANGE
// (a declaration moves it), so it is a getter, not a value:
//   activeRoot()  → { project, root } | null — the declaration, live
//   actViaPage(a) → the dispatch's page leg (core/dispatch.ts), or null when
//                   this host predates the channel
// A tool's file primitives act in the ACTIVE root; a page-owned root routes
// the act to the page, exactly as a turn's; and with no root declared the
// tool refuses by name — an extension never invents a place to write.
let hostHooks = { activeRoot: () => null, actViaPage: null };
export function setHostHooks(hooks) {
  hostHooks = { ...hostHooks, ...hooks };
}

/** The active root's machine path, or null when it is not this process's to touch. */
function activeMachineRoot() {
  const ar = hostHooks.activeRoot?.() ?? null;
  return ar?.root?.kind === "machine" ? ar.root.path : null;
}

/** Where an ACT is recorded: with the root it hit (the root's log answers "what did it try
 *  here"), while host-level records (admissions, imports) stay in the extensions ledger. */

export const PLACEMENT = "machine"; // this server process: docs/02-environment.md's E2, plain node host

const budgets = new Map(); // tool name -> requests used
const registry = new Map(); // tool name -> { descriptor, tool, enforced, gets, cannotHave }

// ── the host token (bead voicebox-beads-m2i) ───────────────────────────
// Admission is the host's act, so the route that performs it must be one the
// page cannot call. The mechanism is the design's own (docs/02 §1.5): a
// host-generated secret, file mode 0600, living in the host's OWN directory —
// outside the model's root and served by no route, so neither the page nor
// the model can read it. The person's shell can; that is the point.
import { randomBytes } from "node:crypto";
const HOST_TOKEN_FILE = path.join(EXTENSIONS_DIR, ".host-token");
function ensureHostToken() {
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  if (!existsSync(HOST_TOKEN_FILE)) {
    writeFileSync(HOST_TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
}
ensureHostToken();

export function hostTokenOk(provided) {
  try {
    const expected = readFileSync(HOST_TOKEN_FILE, "utf8").trim();
    return typeof provided === "string" && provided.length === expected.length && provided === expected;
  } catch {
    return false; // no readable token = no admission, fail closed
  }
}

// ── the admission ledger (bead voicebox-beads-0xp) ─────────────────────
// Set membership is defined by RECORDED ADMISSIONS, not by directory contents.
// A file in the host directory without a ledger entry is PRESENT, NOT ADMITTED:
// visible in the inventory as exactly that, and never live. This closes the
// sweep-in driven on 2026-09-20: the next host-triggered reload used to walk
// the directory and load files nobody admitted.
const LEDGER_FILE = path.join(EXTENSIONS_DIR, ".ledger.jsonl");
function appendLedger(entry) {
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
}
function recordAdmission(id) {
  appendLedger({ id, at: new Date().toISOString(), decision: "admitted" });
}
function admittedIds() {
  const ids = new Set();
  try {
    for (const line of readFileSync(LEDGER_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if ((e.decision === "admitted" || e.decision === "reconfigured") && e.id) ids.add(e.id);
        if (e.decision === "revoked" && e.id) ids.delete(e.id);
      } catch { /* a torn line is not an admission */ }
    }
  } catch { /* no ledger yet: nothing is admitted */ }
  return ids;
}

// ── audit: entries in core/audit.ts's shape, appended per root ─────────────
function audit(act, decision, rule, result, observed, why, actor = undefined, actRootPath = null) {
  try {
    const file = actRootPath ? path.join(actRootPath, ".audit", "extensions.jsonl") : AUDIT_FILE;
    mkdirSync(path.dirname(file), { recursive: true });
    const entry = makeEntry(
      "atlas@machine", // project — placement IS part of identity (core/project.ts)
      actRootPath ? `machine:${actRootPath}` : "workspace", // the root the act hit, when it hit one
      "server", // one instance in M0
      actor,
      act,
      decision,
      rule,
      result,
      observed,
      null,
    );
    if (why) entry.why = why;
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (e) {
    // The audit must never take the loop down with it.
    console.error(`[extensions] audit write failed: ${e?.message ?? e}`);
  }
}

// ── the model's door: propose ──────────────────────────────────────────────

export function propose(descriptor, source = "model") {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return { ok: false, error: "a proposal is a descriptor object" };
  }
  if (!/^[a-z0-9_-]+$/.test(String(descriptor.id ?? ""))) {
    return { ok: false, error: "proposal id must match /^[a-z0-9_-]+$/" };
  }
  if (!Array.isArray(descriptor.tools)) {
    return { ok: false, error: "a proposal carries a tools array" };
  }
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const record = { ...descriptor, source, state: "pending", proposedAt: new Date().toISOString() };
  // proposals/<id>.json IS the tier 1 artefact: a file inside the root,
  // reported, revertible. Nothing here loads, evaluates or registers.
  writeFileSync(path.join(PROPOSALS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
  return { ok: true, id: record.id, state: "pending" };
}

function readProposal(id) {
  const file = path.join(PROPOSALS_DIR, `${path.basename(id)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listIds(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// ── the disclosure: the resolved plan IS the source ────────────────────────
// (bead voicebox-beads-vwb: what it can reach, what it will be given, what it
// cannot have — before anyone confirms anything.)

export function planFor(descriptor, existingToolNames) {
  const gate = admit(descriptor, PLACEMENT, new Set([...(existingToolNames ?? []), ...TASK_TOOLS]));
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    source: descriptor.source ?? "model",
    runsIn: descriptor.runsIn,
    declared: descriptor.capabilities ?? [],
    bounds: descriptor.bounds ?? {},
    tools: descriptor.tools ?? [],
    gate,
  };
}

export function proposalPlan(id) {
  const safeId = path.basename(String(id));
  let record = readProposal(safeId);
  let state = record?.state ?? null;
  if (!record) {
    // A PRESENT file (in the host directory, never admitted) has a plan too — the
    // disclosure must exist before the host decides on it (voicebox-beads-t9j).
    const hostFile = path.join(EXTENSIONS_DIR, `${safeId}.json`);
    if (!existsSync(hostFile)) return null;
    try {
      record = { ...JSON.parse(readFileSync(hostFile, "utf8")), state: "present-not-admitted" };
    } catch {
      return null;
    }
  }
  return { ...planFor(record, existingNamesExcept()), state: record.state, refusal: record.refusal ?? null };
}

export function cataloguePlan(id) {
  const file = path.join(CATALOGUE_DIR, `${path.basename(id)}.json`);
  if (!existsSync(file)) return null;
  return planFor(JSON.parse(readFileSync(file, "utf8")), existingNamesExcept(id));
}

// ── the person's one-use console code (the page never receives the host token) ──
const approvals = createExtensionApprovals();
export function requestApproval(id) {
  const plan = proposalPlan(id);
  if (!plan) return { ok: false, refused: "approval-no-proposal", why: "No extension to review. Stage it first." };
  if (plan.gate.decision !== "admitted" || plan.state === "admitted") {
    return { ok: false, refused: "approval-unavailable", why: plan.gate.why ?? "This extension is already admitted." };
  }
  return approvals.request(plan);
}

export function approveWithCode(id, requestId, code) {
  const plan = proposalPlan(id);
  const checked = approvals.consume(requestId, code, plan);
  if (!checked.ok) return checked;
  const actor = { name: "human-at-host", harness: "host-console-code", session: requestId };
  // A decision must be recorded BEFORE admission. Unlike runtime telemetry, failure here is fatal.
  try {
    mkdirSync(WORKSPACE, { recursive: true });
    const entry = makeEntry("atlas@machine", "workspace", "server", actor,
      { kind: "import", target: `proposals/${id}`, tool: "extensions.approve" },
      "confirm", "human-approved-extension", "ok", null);
    entry.approval = { method: "single-use-host-code", decision: "admit", plan };
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
  } catch {
    return { ok: false, refused: "approval-audit-unwritable", why: "The human decision could not be recorded. Fix the extension workspace audit and request a new code. Nothing was admitted." };
  }
  const result = admitProposal(id, "admit", actor, plan);
  return { ...result, ok: result.ok && result.decision === "admitted" };
}

// ── the host's act: admit (and the host's veto: deny) ──────────────────────

export function admitProposal(id, decision = "admit", actor = undefined, reviewedPlan = undefined) {
  const safeId = path.basename(String(id));
  let record = readProposal(safeId);
  let fromHostDir = false;
  if (!record) {
    // The direct door for a PRESENT file (voicebox-beads-t9j): a descriptor sitting in the
    // host's directory without a recorded admission can be decided HERE — same route, same
    // host token, same gate, same ledger. No staging detour; no new authority appears.
    const hostFile = path.join(EXTENSIONS_DIR, `${safeId}.json`);
    if (existsSync(hostFile)) {
      try {
        record = { ...JSON.parse(readFileSync(hostFile, "utf8")), state: "pending" };
        fromHostDir = true;
      } catch {
        return { ok: false, error: `the descriptor '${safeId}' in the host directory is unreadable` };
      }
    }
  }
  if (!record) return { ok: false, error: `no proposal '${safeId}'` };
  if (record.state === "admitted" && !fromHostDir) return { ok: false, error: `'${safeId}' is already admitted` };
  if (reviewedPlan) {
    const currentPlan = { ...planFor(record, existingNamesExcept()), state: fromHostDir ? "present-not-admitted" : record.state, refusal: record.refusal ?? null };
    if (JSON.stringify(currentPlan) !== JSON.stringify(reviewedPlan)) {
      return { ok: false, refused: "approval-plan-changed", why: "The extension changed during approval. Review it and request a new code." };
    }
  }

  if (decision === "deny") {
    const refusal = { rule: "host-deny", why: "denied by the host: the person reviewed the plan and refused it" };
    if (fromHostDir) {
      // A present file the host denies: recorded in the ledger so the history shows
      // it was DECIDED, and it stays present-not-admitted — never live.
      appendLedger({ id: safeId, at: new Date().toISOString(), decision: "deny" });
      loadRegistry(); // the state is rebuilt from the ledger, so the inventory tells the truth
    } else {
      record.state = "refused";
      record.refusal = refusal;
      writeFileSync(path.join(PROPOSALS_DIR, `${safeId}.json`), JSON.stringify(record, null, 2));
    }
    audit({ kind: "import", target: `proposals/${safeId}`, tool: "extensions.admit" }, "refuse", refusal.rule, "refused", null, refusal.why);
    return { ok: true, id: safeId, decision: "refused", rule: refusal.rule, why: refusal.why };
  }

  const gate = admit(record, PLACEMENT, existingNamesExcept());
  if (gate.decision === "refused") {
    record.state = "refused";
    record.refusal = { rule: gate.rule, why: gate.why };
    if (!fromHostDir) writeFileSync(path.join(PROPOSALS_DIR, `${safeId}.json`), JSON.stringify(record, null, 2));
    // THE ARTEFACT: a refusal is an audit entry with the rule id, and the
    // tool is NOT in the loaded set.
    audit({ kind: "import", target: `proposals/${safeId}`, tool: "extensions.admit" }, "refuse", gate.rule, "refused", null, gate.why);
    return { ok: true, id: safeId, decision: "refused", rule: gate.rule, why: gate.why };
  }

  // Admitted: the descriptor lands in the HOST's directory. The move is the
  // admission — a model cannot perform it, because extensions/ is outside
  // its containment root, and the route is the only writer.
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  const tmp = path.join(EXTENSIONS_DIR, `.${safeId}.tmp`);
  const dest = path.join(EXTENSIONS_DIR, `${safeId}.json`);
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, dest);
  recordAdmission(safeId); // the ledger: set membership is recorded admissions, not directory contents
  if (!fromHostDir) {
    record.state = "admitted";
    writeFileSync(path.join(PROPOSALS_DIR, `${safeId}.json`), JSON.stringify(record, null, 2));
  }
  loadRegistry(); // the reload: host-triggered, and only here
  audit({ kind: "import", target: `extensions/${safeId}`, tool: "extensions.admit" }, "allow", "admitted", "ok", { exists: true }, null, actor);
  return { ok: true, id: safeId, decision: "admitted", enforced: gate.enforced, gets: gate.gets };
}

// ── the user's door: sideload (discover -> confirm-first -> same gate) ─────

export function catalogue() {
  return listIds(CATALOGUE_DIR).map((id) => {
    try {
      const descriptor = JSON.parse(readFileSync(path.join(CATALOGUE_DIR, `${id}.json`), "utf8"));
      // The preview answers "if admitted, what would the gate say" — a
      // catalogue entry whose own earlier sideload is already loaded must not
      // collide with itself, so its own tool names are excluded from the check.
      return { id, name: descriptor.name, description: descriptor.description, runsIn: descriptor.runsIn, declared: descriptor.capabilities ?? [], preview: planFor({ ...descriptor, id }, existingNamesExcept(id)).gate };
    } catch (e) {
      return { id, error: `unreadable catalogue entry: ${e?.message ?? e}` };
    }
  });
}

// An extension cannot impersonate the authenticated task door, even during a reload.
/**
 * REVOCATION (voicebox-beads-qg1) — withdrawing a RUNNING extension.
 *
 * What "running" means here: the extension's tools are LOADED — registry membership,
 * rebuilt by loadRegistry() from the host directory filtered by the ledger. There is no
 * session to close and no standing permission to retract (permissions are per-call
 * approval cards). The one thing to release is registry membership, and its durable
 * root is the descriptor file plus its ledger admission. Revocation = a revoked ledger
 * entry (carrying the descriptor snapshot, so re-adding stays possible from history)
 * + the descriptor file removed + reload. After it: the tools refuse unknown-tool and
 * the inventory no longer lists them.
 */
export function revokeExtension(id, actor = undefined) {
  const safeId = path.basename(String(id));
  const entry = [...registry.values()].find((e) => e.descriptorId === safeId);
  if (!entry) {
    return { ok: false, refused: "extension-not-admitted", why: `'${safeId}' is not a running extension — nothing to revoke (the inventory lists what is running)` };
  }
  const descriptorSnapshot = entry.descriptor;
  // The ledger keeps the descriptor snapshot: the extension's text survives the file
  // removal, so "was it ever admitted?" and "what exactly was it?" are both answerable.
  appendLedger({ id: safeId, at: new Date().toISOString(), decision: "revoked", actor: actor ?? "host", descriptor: descriptorSnapshot });
  rmSync(path.join(EXTENSIONS_DIR, `${safeId}.json`), { force: true });
  loadRegistry(); // the reload: the tools leave the loaded set at once
  audit({ kind: "import", target: `extensions/${safeId}`, tool: "extensions.revoke" }, "allow", "revoked", "ok", { exists: false }, null, actor);
  return { ok: true, id: safeId, decision: "revoked", note: "the extension's tools are no longer loaded; re-add it from the catalogue with corrected bounds if wanted" };
}

/**
 * RECONFIGURATION (voicebox-beads-ud5) — updating parameters or bounds on a RUNNING extension.
 *
 * Atomically updates the extension descriptor in the host directory, verifies the admission gate,
 * records the reconfiguration in the ledger, and reloads the registry so the new bounds are
 * immediately active without server restart or manual file editing.
 */
export function reconfigureExtension(id, updates = {}, actor = undefined) {
  const safeId = path.basename(String(id));
  const entry = [...registry.values()].find((e) => e.descriptorId === safeId);
  if (!entry) {
    return { ok: false, refused: "extension-not-admitted", why: `'${safeId}' is not a running extension — nothing to reconfigure (the inventory lists what is running)` };
  }
  const current = entry.descriptor;
  const newBounds = { ...(current.bounds ?? {}) };
  if (updates.bounds && typeof updates.bounds === "object") {
    if (Array.isArray(updates.bounds.hosts)) {
      newBounds.hosts = updates.bounds.hosts.map((h) => String(h).trim()).filter(Boolean);
    } else if (typeof updates.bounds.hosts === "string") {
      newBounds.hosts = updates.bounds.hosts.split(",").map((h) => h.trim()).filter(Boolean);
    }
    if (updates.bounds.maxRequests !== undefined) {
      const parsed = Number.parseInt(String(updates.bounds.maxRequests), 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        newBounds.maxRequests = parsed;
      }
    }
    if (updates.bounds.maxBytes !== undefined) {
      const parsed = Number.parseInt(String(updates.bounds.maxBytes), 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        newBounds.maxBytes = parsed;
      }
    }
  }

  const updated = {
    ...current,
    id: safeId,
    bounds: newBounds,
  };
  if (Array.isArray(updates.tools)) {
    updated.tools = updates.tools;
  }

  const gate = admit(updated, PLACEMENT, existingNamesExcept(safeId));
  if (gate.decision === "refused") {
    audit({ kind: "import", target: `extensions/${safeId}`, tool: "extensions.reconfigure" }, "refuse", gate.rule, "refused", null, gate.why, actor);
    return { ok: false, refused: gate.rule, why: gate.why };
  }

  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  const tmp = path.join(EXTENSIONS_DIR, `.${safeId}.tmp`);
  const dest = path.join(EXTENSIONS_DIR, `${safeId}.json`);
  writeFileSync(tmp, JSON.stringify(updated, null, 2));
  renameSync(tmp, dest);
  appendLedger({ id: safeId, at: new Date().toISOString(), decision: "reconfigured", actor: actor ?? "host", descriptor: updated });
  loadRegistry();
  audit({ kind: "import", target: `extensions/${safeId}`, tool: "extensions.reconfigure" }, "allow", "reconfigured", "ok", { exists: true }, null, actor);
  return { ok: true, id: safeId, decision: "reconfigured", bounds: updated.bounds, note: "the extension's configuration has been updated and applied" };
}

function existingNamesExcept(id) {
  const own = new Set([...registry.values()].filter((e) => e.descriptorId === id).map((e) => e.tool.name));
  return new Set([...TASK_TOOLS, ...[...registry.keys()].filter((k) => !own.has(k))]);
}

export function sideload(id) {
  const file = path.join(CATALOGUE_DIR, `${path.basename(id)}.json`);
  if (!existsSync(file)) return { ok: false, error: `no catalogue entry '${id}'` };
  const descriptor = JSON.parse(readFileSync(file, "utf8"));
  // A sideload is a PROPOSAL from the user's door. It lands pending, in the
  // same directory, against the same gate — it must not reload its own
  // proposal, and it does not: only admitProposal touches the loaded set.
  return propose({ ...descriptor, id }, "catalogue");
}

// ── the registry: the loaded set, rebuilt ONLY from the host directory ─────

/** The attribution lookup a routed call is re-checked against: does THIS
 * admitted descriptor carry THIS tool, and with what bounds? */
export function lookupAdmitted(descriptorId, tool) {
  for (const entry of registry.values()) {
    if (entry.descriptorId === descriptorId && entry.tool.name === tool) {
      return { bounds: entry.descriptor.bounds ?? {}, tool: entry.tool };
    }
  }
  return null;
}

const presentNotAdmitted = new Set(); // in the directory, never admitted — visible, never live

function loadRegistry() {
  registry.clear();
  budgets.clear();
  presentNotAdmitted.clear();
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  const admitted = admittedIds(); // set membership is RECORDED ADMISSIONS, not directory contents
  for (const id of listIds(EXTENSIONS_DIR)) {
    try {
      const record = JSON.parse(readFileSync(path.join(EXTENSIONS_DIR, `${id}.json`), "utf8"));
      if (!admitted.has(id)) {
        // Present, not admitted: visible in the inventory as exactly that, and
        // never live. This is the honest state for a file that arrived without
        // the host's decision — the sweep-in driven on 2026-09-20 is closed.
        presentNotAdmitted.add(id);
        continue;
      }
      // Fail closed at load: a file the host admitted still re-runs the gate —
      // the loaded set is what passed BOTH the admission and the gate.
      const gate = admit(record, PLACEMENT, existingNamesExcept());
      if (gate.decision !== "admitted") {
        console.error(`[extensions] '${id}' is admitted but FAILS the gate (${gate.rule}) — not loaded`);
        continue;
      }
      for (const tool of record.tools) {
        registry.set(tool.name, { descriptorId: id, descriptor: record, tool, ...gate });
      }
    } catch (e) {
      console.error(`[extensions] '${id}' unreadable — not loaded: ${e?.message ?? e}`);
    }
  }
}

// ── the inventory: declared against enforced, per extension (vwb) ──────────

export function inventory() {
  const extensions = [...new Set([...registry.values()].map((e) => e.descriptorId))].map((id) => {
    const entry = registry.get([...registry.keys()].find((k) => registry.get(k).descriptorId === id));
    return {
      id,
      name: entry.descriptor.name,
      source: entry.descriptor.source,
      runsIn: entry.descriptor.runsIn,
      declared: entry.descriptor.capabilities ?? [],
      enforced: entry.enforced, // capability -> mechanism — declared is NOT enforced; this is the difference, shown
      bounds: entry.descriptor.bounds ?? {},
      tools: entry.descriptor.tools.map((t) => t.name),
      // Invocation metadata, not descriptor params (which may contain private defaults).
      toolDetails: entry.descriptor.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        primitive: t.primitive,
        arguments: t.primitive === "http-get" ? ["url"] : t.primitive === "write-file" ? ["path", "content"] : t.primitive === "read-file" ? ["path"] : [],
      })),
      gets: entry.gets,
      cannotHave: entry.cannotHave,
    };
  });
  const proposals = listIds(PROPOSALS_DIR).map((id) => {
    const r = readProposal(id);
    return r ? { id, name: r.name, state: r.state, source: r.source, declared: r.capabilities ?? [], refusal: r.refusal ?? null } : { id, state: "unreadable" };
  });
  // The inventory reads the DIRECTORY TRUTH at call time, not the last reload: a file
  // dropped mid-session is visible as present-not-admitted immediately (voicebox-beads-t9j).
  const admittedNow = admittedIds();
  const present = listIds(EXTENSIONS_DIR)
    .filter((id) => !admittedNow.has(id))
    .map((id) => {
      try {
        const r = JSON.parse(readFileSync(path.join(EXTENSIONS_DIR, `${id}.json`), "utf8"));
        return { id, name: r.name, state: "present-not-admitted", note: "in the host directory without a recorded admission — visible, never live" };
      } catch {
        return { id, state: "present-not-admitted", note: "unreadable, never admitted" };
      }
    });
  return { placement: PLACEMENT, extensions, proposals, present, catalogueCount: catalogue().length };
}

// ── the runtime: mediated interfaces, bounds enforced per call ─────────────

// ponytail: local copy of the server's containment shape — 6 lines, same
// check; unify into a shared lib if a third copy appears.
// The base is the ACTIVE root (gto), handed per call — never the boot-time WORKSPACE.
function contained(base, p) {
  const rel = path.relative(base, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// A redirect never leaves the mediated fetch's sight: every hop is checked
// against bounds.hosts and charged against the budget, and the audit records
// the URL that actually SERVED the bytes, not only the one requested.
// (Review finding, isocan-flash 2026-09-19: plain fetch follows redirects by
// default, so a declared host answering 302 reached an undeclared origin
// while the report named the declared host — the reachable set was not the
// reviewed set.)
const MAX_REDIRECT_HOPS = 5; // ponytail: a constant; promote to bounds.maxRedirects if a tool ever needs more
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function callHttp(tool, entry, args, act) {
  const bounds = entry.descriptor.bounds ?? {};
  const raw = String(args?.url ?? tool.params?.url ?? "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refused: "bad-url", why: `'${raw.slice(0, 80)}' is not a URL the mediated fetch will consider` };
  }
  if (!(bounds.hosts ?? []).includes(url.hostname)) {
    // The named refusal: the bound is the declaration made true.
    return { ok: false, refused: "host-not-allowed", why: `mediated fetch refuses '${url.hostname}': bounds.hosts is [${(bounds.hosts ?? []).join(", ")}]` };
  }
  const chain = [url.href];
  for (;;) {
    // The budget counts REQUESTS, not calls — a redirect is a request the
    // declared host did not have to serve, and it is charged like one.
    const used = budgets.get(tool.name) ?? 0;
    if (used >= (bounds.maxRequests ?? 0)) {
      return { ok: false, refused: "budget-exhausted", why: `budget exhausted for '${tool.name}': ${used} of ${bounds.maxRequests} requests used — raise bounds.maxRequests and re-admit` };
    }
    budgets.set(tool.name, used + 1);
    let r;
    try {
      r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    } catch (e) {
      const why = e?.message ?? String(e);
      audit(act, "refuse", "fetch-failed", "refused", { requested: url.href }, why);
      return { ok: false, refused: "fetch-failed", why };
    }
    if (REDIRECT_STATUS.has(r.status)) {
      const loc = r.headers.get("location");
      try { await r.arrayBuffer(); } catch { /* drain the socket; the body is not ours to read */ }
      if (!loc) {
        const why = `${r.status} from '${url.hostname}' carried no Location`;
        audit(act, "refuse", "redirect-without-location", "refused", { requested: url.href }, why);
        return { ok: false, refused: "redirect-without-location", why, chain };
      }
      let next;
      try {
        next = new URL(loc, url); // relative Locations resolve against the redirecting URL
      } catch {
        const why = `Location '${loc.slice(0, 80)}' does not resolve`;
        audit(act, "refuse", "bad-redirect", "refused", { requested: url.href }, why);
        return { ok: false, refused: "bad-redirect", why, chain };
      }
      chain.push(next.href);
      if (!(bounds.hosts ?? []).includes(next.hostname)) {
        // The bound holds across the redirect, BY NAME — the hop is named
        // exactly like a first call to it would be.
        const why = `redirect to '${next.hostname}' refuses: not in bounds.hosts [${(bounds.hosts ?? []).join(", ")}] (chain: ${chain.join(" → ")})`;
        audit(act, "refuse", "redirect-host-not-allowed", "refused", { requested: chain[0] }, why);
        return { ok: false, refused: "redirect-host-not-allowed", why, chain };
      }
      if (chain.length > MAX_REDIRECT_HOPS) {
        const why = `more than ${MAX_REDIRECT_HOPS} redirects (chain: ${chain.join(" → ")})`;
        audit(act, "refuse", "too-many-redirects", "refused", { requested: chain[0] }, why);
        return { ok: false, refused: "too-many-redirects", why, chain };
      }
      url = next;
      continue;
    }
    const body = await r.text();
    // observed carries the OUTCOME: the URL that actually served the bytes.
    audit(act, "allow", entry.descriptorId, "ok", { bytes: body.length, servedBy: url.href, via: chain }, null);
    return { ok: true, status: r.status, host: url.hostname, servedBy: url.href, via: chain, request: `${used + 1}/${bounds.maxRequests}`, body: body.slice(0, 2000) };
  }
}

/**
 * callTool(name, args) — the ONLY way an admitted tool runs.
 * Resolves to { ok, ... } or { ok: false, refused, why }.
 */
export async function callTool(name, args = {}) {
  const wanted = String(name);
  const entry = registry.get(wanted);
  if (!entry) {
    // Name the state, not just the miss: a caller should learn WHY the tool
    // it remembers is not here — pending, refused (with the rule), or unknown.
    const proposal = listIds(PROPOSALS_DIR)
      .map((id) => readProposal(id))
      .find((r) => r?.tools?.some((t) => t.name === wanted));
    if (proposal?.state === "pending") return { ok: false, refused: "not-admitted", why: `'${wanted}' is a pending proposal — the host has not admitted it` };
    if (proposal?.state === "refused") return { ok: false, refused: "admission-refused", why: `'${wanted}' was refused at admission (${proposal.refusal?.rule}): ${proposal.refusal?.why}` };
    return { ok: false, refused: "unknown-tool", why: `no tool '${wanted}' in the loaded set` };
  }

  const { tool } = entry;
  const act = { kind: PRIMITIVE_NEEDS[tool.primitive].includes("network") ? "network" : PRIMITIVE_NEEDS[tool.primitive][0] ?? "read", target: String(args?.path ?? tool.params?.path ?? tool.params?.url ?? tool.name), tool: tool.name };

  if (tool.primitive === "wasm") {
    // The wasm branch: a pure module inside its own containment. The CALL-TIME rehash lives in
    // callWasmTool — the only path a tool runs, so the check cannot be walked around. No file
    // scope, no network: the act is the compute itself, and the audit records which digest ran.
    const result = await callWasmTool(tool, args);
    audit(act, result.ok ? "allow" : "refuse", entry.descriptorId, result.ok ? "ok" : (result.refused ?? "error"), result.ok ? { digest: result.digest, inputBytes: result.inputBytes, returned: result.returned } : null, result.ok ? null : result.why);
    return result;
  }
  if (tool.primitive === "now") {
    const result = { ok: true, action: "now", content: new Date().toString() };
    audit(act, "allow", entry.descriptorId, "ok", { exists: true }, null);
    return result;
  }
  if (tool.primitive === "list-files") {
    // The ACTIVE root's files (gto) — never the boot-time WORKSPACE's. A page-owned root is
    // listed by the page, through the same dispatch a turn uses.
    const ar = hostHooks.activeRoot?.() ?? null;
    if (!ar) return { ok: false, refused: "root-not-declared", why: "no project root is declared, so there is nothing to list — the environment declares one (POST /api/root) when it opens a project" };
    if (!ar.root || ar.root.kind !== "machine") {
      if (hostHooks.actViaPage) {
        const routed = await hostHooks.actViaPage({ verb: "list", name: "", turn: `tool:${tool.name}` });
        audit(act, routed.ok ? "allow" : "refuse", entry.descriptorId, routed.ok ? "ok" : "refused", { via: "page" }, routed.ok ? null : routed.error ?? routed.why);
        return routed.ok ? { ok: true, action: "list", files: routed.files ?? [], via: "page" } : { ok: false, refused: routed.refused ?? "page-refused", why: routed.why ?? routed.error, via: "page" };
      }
      return { ok: false, refused: "root-not-reachable-from-here", why: "the active root belongs to the page, and this host has no channel to it — the act belongs to that side" };
    }
    const files = readdirSync(ar.root.path).filter((f) => f !== "proposals" && !f.startsWith("."));
    audit(act, "allow", entry.descriptorId, "ok", { exists: true }, null, undefined, ar.root.path);
    return { ok: true, action: "list", files };
  }
  if (tool.primitive === "http-get") {
    // Network tools take a URL, not a path — the generic file-scope logic
    // below does not apply to them.
    return callHttp(tool, entry, args, act);
  }
  // The file primitives (read-file, write-file) resolve against the ACTIVE root.
  const activeRoot = hostHooks.activeRoot?.() ?? null;
  if (!activeRoot) return { ok: false, refused: "root-not-declared", why: "no project root is declared, so there is nowhere to act — the environment declares one (POST /api/root) when it opens a project" };
  if (activeRoot.root?.kind !== "machine") {
    // The root is the page's: the act routes through the same dispatch a turn takes
    // (core/dispatch.ts), and the page's own audit records the act.
    if (!hostHooks.actViaPage) {
      return { ok: false, refused: "root-not-reachable-from-here", why: "the active root belongs to the page, and this host has no channel to it — the act belongs to that side" };
    }
    const verb = tool.primitive === "read-file" ? "read" : "write";
    const rel0 = String(args?.path ?? tool.params?.path ?? "");
    const routed = await hostHooks.actViaPage({ verb, name: rel0, ...(verb === "write" ? { content: String(args?.content ?? tool.params?.content ?? "") } : {}), turn: `tool:${tool.name}` });
    audit(act, routed.ok ? "allow" : "refuse", entry.descriptorId, routed.ok ? "ok" : "refused", { via: "page" }, routed.ok ? null : routed.error ?? routed.why);
    if (!routed.ok) return { ok: false, refused: routed.refused ?? "page-refused", why: routed.why ?? routed.error, via: "page" };
    if (verb === "read") return { ok: true, action: rel0, content: routed.content ?? "", via: "page" };
    return { ok: true, action: routed.action ?? `wrote ${rel0}`, via: "page" };
  }
  const rel = String(args?.path ?? tool.params?.path ?? "");
  const candidate = path.resolve(activeRoot.root.path, rel);
  if (!contained(activeRoot.root.path, candidate)) {
    const refused = { ok: false, refused: "outside-root", why: `'${rel}' escapes the project root — the scope the tool was admitted under` };
    audit(act, "refuse", "outside-root", "refused", null, refused.why, undefined, activeRoot.root.path);
    return refused;
  }
  if (protectedAuditPath(activeRoot.root.path, candidate)) {
    return { ok: false, refused: "protected-audit", why: "the audit is host-owned; task records require authenticated task_status, not a raw file read or write" };
  }
  if (tool.primitive === "read-file") {
    try {
      const real = realpathSync(candidate);
      if (!contained(activeRoot.root.path, real)) throw Object.assign(new Error("escapes"), { code: "EESC" });
      const content = readFileSync(real, "utf8");
      audit(act, "allow", entry.descriptorId, "ok", { exists: true, bytes: content.length }, null, undefined, activeRoot.root.path);
      return { ok: true, action: rel, content };
    } catch (e) {
      const why = e.code === "ENOENT" ? `no file '${rel}'` : `'${rel}' escapes the project root`;
      audit(act, "refuse", e.code === "ENOENT" ? "missing" : "outside-root", "refused", null, why, undefined, activeRoot.root.path);
      return { ok: false, refused: e.code === "ENOENT" ? "missing" : "outside-root", why };
    }
  }
  if (tool.primitive === "write-file") {
    const maxBytes = entry.descriptor.bounds?.maxBytes ?? 65536;
    const content = String(args?.content ?? tool.params?.content ?? "");
    if (content.length > maxBytes) {
      const refused = { ok: false, refused: "over-budget", why: `write of ${content.length} bytes exceeds bounds.maxBytes (${maxBytes})` };
      audit(act, "refuse", "over-budget", "refused", null, refused.why);
      return refused;
    }
    try {
      const real = realpathSync(candidate);
      if (!contained(activeRoot.root.path, real)) throw Object.assign(new Error("escapes"), { code: "EESC" });
    } catch (e) {
      if (e.code !== "ENOENT") {
        const refused = { ok: false, refused: "outside-root", why: `'${rel}' escapes the project root` };
        audit(act, "refuse", "outside-root", "refused", null, refused.why, undefined, activeRoot.root.path);
        return refused;
      }
    }
    writeFileSync(candidate, content);
    audit(act, "allow", entry.descriptorId, "ok", { exists: true, bytes: content.length }, null, undefined, activeRoot.root.path);
    return { ok: true, action: `wrote ${rel} (${content.length} bytes)` };
  }
  return { ok: false, refused: "unknown-primitive", why: `primitive '${tool.primitive}' has no runtime — the gate should never have admitted this` };
}

// Boot = the host's load. Every later load happens only through admitProposal.
loadRegistry();
