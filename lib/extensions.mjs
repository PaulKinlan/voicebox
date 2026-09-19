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
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, renameSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { admit, PRIMITIVE_NEEDS } from "../core/extensions.ts";
import { makeEntry } from "../core/audit.ts";

const REPO = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const WORKSPACE = path.join(REPO, "workspace");
const PROPOSALS_DIR = path.join(WORKSPACE, "proposals"); // the model's door — inside its root
const EXTENSIONS_DIR = path.join(REPO, "extensions"); // the host's directory — outside the root
const CATALOGUE_DIR = path.join(REPO, "catalogue"); // strangers' extensions, discover + sideload
const AUDIT_FILE = path.join(WORKSPACE, "audit.jsonl");

export const PLACEMENT = "machine"; // this server process: docs/02-environment.md's E2, plain node host

const budgets = new Map(); // tool name -> requests used
const registry = new Map(); // tool name -> { descriptor, tool, enforced, gets, cannotHave }

// ── audit: entries in core/audit.ts's shape, appended per root ─────────────
function audit(act, decision, rule, result, observed, why) {
  try {
    mkdirSync(WORKSPACE, { recursive: true });
    const entry = makeEntry(
      "atlas@machine", // project — placement IS part of identity (core/project.ts)
      "workspace", // the execution root on this placement
      "server", // one instance in M0
      act,
      decision,
      rule,
      result,
      observed,
      null,
    );
    if (why) entry.why = why;
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
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
  const gate = admit(descriptor, PLACEMENT, existingToolNames);
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
  const record = readProposal(id);
  if (!record) return null;
  return { ...planFor(record, new Set(registry.keys())), state: record.state, refusal: record.refusal ?? null };
}

export function cataloguePlan(id) {
  const file = path.join(CATALOGUE_DIR, `${path.basename(id)}.json`);
  if (!existsSync(file)) return null;
  return planFor(JSON.parse(readFileSync(file, "utf8")), existingNamesExcept(id));
}

// ── the host's act: admit (and the host's veto: deny) ──────────────────────

export function admitProposal(id, decision = "admit") {
  const record = readProposal(id);
  if (!record) return { ok: false, error: `no proposal '${id}'` };
  if (record.state === "admitted") return { ok: false, error: `'${id}' is already admitted` };

  if (decision === "deny") {
    const refusal = { rule: "host-deny", why: "denied by the host: the person reviewed the plan and refused it" };
    record.state = "refused";
    record.refusal = refusal;
    writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
    audit({ kind: "import", target: `proposals/${id}`, tool: "extensions.admit" }, "refuse", refusal.rule, "refused", null, refusal.why);
    return { ok: true, id, decision: "refused", rule: refusal.rule, why: refusal.why };
  }

  const gate = admit(record, PLACEMENT, new Set(registry.keys()));
  if (gate.decision === "refused") {
    record.state = "refused";
    record.refusal = { rule: gate.rule, why: gate.why };
    writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
    // THE ARTEFACT: a refusal is an audit entry with the rule id, and the
    // tool is NOT in the loaded set.
    audit({ kind: "import", target: `proposals/${id}`, tool: "extensions.admit" }, "refuse", gate.rule, "refused", null, gate.why);
    return { ok: true, id, decision: "refused", rule: gate.rule, why: gate.why };
  }

  // Admitted: the descriptor lands in the HOST's directory. The move is the
  // admission — a model cannot perform it, because extensions/ is outside
  // its containment root, and the route is the only writer.
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  const tmp = path.join(EXTENSIONS_DIR, `.${id}.tmp`);
  const dest = path.join(EXTENSIONS_DIR, `${id}.json`);
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, dest);
  record.state = "admitted";
  writeFileSync(path.join(PROPOSALS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
  loadRegistry(); // the reload: host-triggered, and only here
  audit({ kind: "import", target: `extensions/${id}`, tool: "extensions.admit" }, "allow", "admitted", "ok", { exists: true }, null);
  return { ok: true, id, decision: "admitted", enforced: gate.enforced, gets: gate.gets };
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

function existingNamesExcept(id) {
  const own = new Set([...registry.values()].filter((e) => e.descriptorId === id).map((e) => e.tool.name));
  return new Set([...registry.keys()].filter((k) => !own.has(k)));
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

function loadRegistry() {
  registry.clear();
  budgets.clear();
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  for (const id of listIds(EXTENSIONS_DIR)) {
    try {
      const record = JSON.parse(readFileSync(path.join(EXTENSIONS_DIR, `${id}.json`), "utf8"));
      // Fail closed at load: a file in the host directory is host-authored,
      // but the gate re-runs anyway — the loaded set is what passed the gate,
      // not what exists.
      const gate = admit(record, PLACEMENT, new Set(registry.keys()));
      if (gate.decision !== "admitted") {
        console.error(`[extensions] '${id}' is in the host directory but FAILS the gate (${gate.rule}) — not loaded`);
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
      gets: entry.gets,
      cannotHave: entry.cannotHave,
    };
  });
  const proposals = listIds(PROPOSALS_DIR).map((id) => {
    const r = readProposal(id);
    return r ? { id, name: r.name, state: r.state, source: r.source, declared: r.capabilities ?? [], refusal: r.refusal ?? null } : { id, state: "unreadable" };
  });
  return { placement: PLACEMENT, extensions, proposals, catalogueCount: catalogue().length };
}

// ── the runtime: mediated interfaces, bounds enforced per call ─────────────

// ponytail: local copy of the server's containment shape — 6 lines, same
// check; unify into a shared lib if a third copy appears.
function contained(p) {
  const rel = path.relative(WORKSPACE, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

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
  const used = budgets.get(tool.name) ?? 0;
  if (used >= (bounds.maxRequests ?? 0)) {
    return { ok: false, refused: "budget-exhausted", why: `budget exhausted for '${tool.name}': ${used} of ${bounds.maxRequests} requests used — raise bounds.maxRequests and re-admit` };
  }
  budgets.set(tool.name, used + 1);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await r.text();
    audit(act, "allow", entry.descriptorId, "ok", { bytes: body.length }, null);
    return { ok: true, status: r.status, host: url.hostname, request: `${used + 1}/${bounds.maxRequests}`, body: body.slice(0, 2000) };
  } catch (e) {
    const why = e?.message ?? String(e);
    audit(act, "refuse", "fetch-failed", "refused", null, why);
    return { ok: false, refused: "fetch-failed", why };
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

  if (tool.primitive === "now") {
    const result = { ok: true, action: "now", content: new Date().toString() };
    audit(act, "allow", entry.descriptorId, "ok", { exists: true }, null);
    return result;
  }
  if (tool.primitive === "list-files") {
    const files = readdirSync(WORKSPACE).filter((f) => f !== "proposals" && !f.startsWith("."));
    audit(act, "allow", entry.descriptorId, "ok", { exists: true }, null);
    return { ok: true, action: "list", files };
  }
  if (tool.primitive === "http-get") {
    // Network tools take a URL, not a path — the generic file-scope logic
    // below does not apply to them.
    return callHttp(tool, entry, args, act);
  }
  const rel = String(args?.path ?? tool.params?.path ?? "");
  const candidate = path.resolve(WORKSPACE, rel);
  if (!contained(candidate)) {
    const refused = { ok: false, refused: "outside-root", why: `'${rel}' escapes the project root — the scope the tool was admitted under` };
    audit(act, "refuse", "outside-root", "refused", null, refused.why);
    return refused;
  }
  if (tool.primitive === "read-file") {
    try {
      const real = realpathSync(candidate);
      if (!contained(real)) throw Object.assign(new Error("escapes"), { code: "EESC" });
      const content = readFileSync(real, "utf8");
      audit(act, "allow", entry.descriptorId, "ok", { exists: true, bytes: content.length }, null);
      return { ok: true, action: rel, content };
    } catch (e) {
      const why = e.code === "ENOENT" ? `no file '${rel}'` : `'${rel}' escapes the project root`;
      audit(act, "refuse", e.code === "ENOENT" ? "missing" : "outside-root", "refused", null, why);
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
      if (!contained(real)) throw Object.assign(new Error("escapes"), { code: "EESC" });
    } catch (e) {
      if (e.code !== "ENOENT") {
        const refused = { ok: false, refused: "outside-root", why: `'${rel}' escapes the project root` };
        audit(act, "refuse", "outside-root", "refused", null, refused.why);
        return refused;
      }
    }
    writeFileSync(candidate, content);
    audit(act, "allow", entry.descriptorId, "ok", { exists: true, bytes: content.length }, null);
    return { ok: true, action: `wrote ${rel} (${content.length} bytes)` };
  }
  return { ok: false, refused: "unknown-primitive", why: `primitive '${tool.primitive}' has no runtime — the gate should never have admitted this` };
}

// Boot = the host's load. Every later load happens only through admitProposal.
loadRegistry();
