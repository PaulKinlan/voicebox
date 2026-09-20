// tests/extensions.test.mjs — the extension admission drive (beads bxx, vwb, rsj).
//
// Driven against the REAL server as a subprocess, assertions on HTTP
// responses and the filesystem — never on the server's own report. The
// through-line, per the brief: build a tool from a prompt, show it loading,
// show it being called, and show the gate REFUSING one — the refusal with its
// named reason is the artefact, not the happy path.
//
//   node --test tests/extensions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER = path.join(ROOT, "server.mjs");
const PORT = 8798;
const REDIRECTOR_PORT = 8799; // a tiny in-test redirector — no external network
const BASE = `http://127.0.0.1:${PORT}`;
// ALL mutable state lives in a scratch directory. The suite never touches a
// file the repository or a real deployment owns — the before-hook used to
// rm -rf the host extension directory and rebuild it, which is the
// untracked-work class (review finding, isocan-flash 2026-09-19).
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-ext-test-"));
const WORKSPACE = path.join(SCRATCH, "workspace");
const PROPOSALS = path.join(WORKSPACE, "proposals");
const HOST_EXTENSIONS = path.join(SCRATCH, "extensions");
const AUDIT = path.join(WORKSPACE, "audit.jsonl");

let child;

async function up() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

test.before(async () => {
  // A declared root must EXIST: the server validates a declaration rather than creating the folder
  // (a typo should be `path-missing`, not a new directory somewhere the user did not ask for).
  mkdirSync(WORKSPACE, { recursive: true });
  process.env.PORT = String(PORT);
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // A DECLARATION of the active root, not a default: the loop refuses by name without one.
      VOICEBOX_WORKSPACE: WORKSPACE,
      VOICEBOX_EXTENSIONS_DIR: HOST_EXTENSIONS,
    },
    stdio: "ignore",
    detached: true,
  });
  assert(await up(), `the server did not come up on ${PORT}`);
});

test.after(() => {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

const get = async (p) => fetch(`${BASE}${p}`);
const getJson = async (p) => (await get(p)).json();
const post = async (p, body) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = async (p, body) => (await post(p, body)).json();
// The HOST's admission call: carries the host token (a 0600 file in the host's
// own directory). The route refuses the page's token-less two-fetch flow.
const admitAsHost = async (id, decision = "admit") =>
  fetch(`${BASE}/api/extensions/admit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken() },
    body: JSON.stringify({ id, confirm: true, decision }),
  }).then((r) => r.json());
const hostToken = () => readFileSync(path.join(HOST_EXTENSIONS, ".host-token"), "utf8").trim();
const turn = (transcript) => postJson("/api/turn", { transcript });

// ── 1. a tool built FROM A PROMPT: pending, disclosed, and NOT loaded ─────
test("a prompt proposes a tool; it lands pending and is NOT callable", async () => {
  const j = await turn("create a tool called clock that tells the time");
  assert.equal(j.result?.ok, true, `the propose turn failed: ${JSON.stringify(j.result)}`);
  assert.match(j.result?.note ?? "", /NOT loaded/);
  // The tier 1 artefact exists inside the model's root…
  const file = path.join(PROPOSALS, "clock-tool.json");
  assert.equal(existsSync(file), true, "the proposal was not written into workspace/proposals/");
  // …and the inventory shows it pending, NOT in the loaded set.
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.id === "clock-tool"), undefined, "a pending proposal appeared in the loaded set");
  assert.equal(inv.proposals.find((p) => p.id === "clock-tool")?.state, "pending");
  // Calling it refuses BY NAME with the reason.
  const call = await turn("run the tool clock");
  assert.equal(call.result?.ok, false);
  assert.equal(call.result?.refused, "not-admitted");
});

test("the disclosure: the resolved plan IS the source, before anyone confirms", async () => {
  const plan = await getJson("/api/extensions/proposals/clock-tool/plan");
  assert.equal(plan.id, "clock-tool");
  assert.equal(plan.tools[0].primitive, "now");
  assert.deepEqual(plan.declared, []);
  // What it cannot have, named even though it never asked:
  assert(plan.gate.cannotHave.some((c) => c.startsWith("exec — absent")), "the disclosure must say what the placement cannot grant");
  // Confirm-first: the deciding POST without confirm decides NOTHING.
  const ask = await fetch(`${BASE}/api/extensions/admit`, { method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken() }, body: JSON.stringify({ id: "clock-tool" }) }).then((r) => r.json());;
  assert.equal(ask.confirmFirst, true);
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.id === "clock-tool"), undefined, "a confirm-less admit changed the loaded set");
});

// ── 2. the host admits; the tool loads and is CALLED through the loop ─────
test("the host admits; the tool is loaded and called through the transcript loop", async () => {
  const r = await admitAsHost("clock-tool");
  assert.equal(r.decision, "admitted", `admission failed: ${JSON.stringify(r)}`);
  // The host directory (outside the model's root) now holds it…
  assert.equal(existsSync(path.join(HOST_EXTENSIONS, "clock-tool.json")), true, "the admitted descriptor is not in the host's directory");
  // …the inventory shows declared against enforced…
  const inv = await getJson("/api/extensions");
  const clock = inv.extensions.find((e) => e.id === "clock-tool");
  assert(clock, "the admitted extension is missing from the inventory");
  assert.deepEqual(clock.enforced, {});
  // …and the LOOP calls it: transcript in, the time out.
  const call = await turn("run the tool clock");
  assert.equal(call.result?.ok, true);
  assert.match(call.result?.content ?? "", /GMT|UTC/, "the clock tool did not return a time");
});

// ── 3. THE REFUSAL — the artefact: an MCP launch is refused by name ───────
test("an MCP server that launches a process is REFUSED, with the named reason, and never loads", async () => {
  // The user's door: sideload the stranger's extension, confirm-first.
  const plan = await postJson("/api/extensions/sideload", { id: "mcp-server-local" });
  assert.equal(plan.confirmFirst, true);
  assert.deepEqual(plan.plan.declared, ["exec"]);
  assert.equal(plan.plan.runsIn, "process");
  const staged = await postJson("/api/extensions/sideload", { id: "mcp-server-local", confirm: true });
  assert.equal(staged.state, "pending");
  assert.match(staged.note ?? "", /NOT loaded/, "a sideload must not load its own proposal");
  // The host decides: the gate refuses.
  const r = await admitAsHost("mcp-server-local");
  assert.equal(r.decision, "refused");
  assert.equal(r.rule, "exec-absent");
  assert.match(r.why, /--allow-run bounds which binary, never what it can do/);
  assert.match(r.why, /container that bounds the child/, "the refusal must name the upgrade path");
  // It is NOT in the loaded set, and calling it names the refusal:
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.id === "mcp-server-local"), undefined);
  assert.equal(inv.proposals.find((p) => p.id === "mcp-server-local")?.state, "refused");
  const call = await turn("run the tool mcp_list_tools");
  assert.equal(call.result?.refused, "admission-refused");
  assert.match(call.result?.why, /exec-absent/);
  // THE ARTEFACT IN THE AUDIT: a refuse entry carrying the rule id.
  const auditLines = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const refusal = auditLines.find((e) => e.decision === "refuse" && e.rule === "exec-absent");
  assert(refusal, "the exec-absent refusal is missing from the audit");
});

// ── 4. the ungated path cannot happen ────────────────────────────────────
test("the model cannot write into the host's extension directory", async () => {
  const evil = path.join(HOST_EXTENSIONS, "evil.js");
  rmSync(evil, { force: true });
  const j = await turn("create a file called ../extensions/evil.js with pwned");
  assert.equal(j.result?.ok, false, "the model wrote outside its root");
  // THE RULE ID AND THE MECHANISM'S OWN WORDS, not a message we wrote: the loop's root is now the
  // ACTIVE PROJECT ROOT (core/root.ts), so "the workspace" became a retired wording — and two tests
  // disagreeing about one string is how that went unnoticed. Assert the fact, not the phrasing.
  assert.equal(j.result?.refused, "outside-root", "the refusal does not name the rule");
  assert.match(j.result?.why ?? "", /'\.\.' segment/, "the refusal does not use the mechanism's own words");
  assert.equal(existsSync(evil), false, "something landed in the host's directory");
});

test("there is no registration door: no endpoint loads a tool directly", async () => {
  const r = await post("/api/extensions/register", { tool: { name: "backdoor" } });
  assert.equal(r.status, 404, "a registration endpoint exists — the ungated path is open");
  const r2 = await post("/api/extensions/reload", {});
  assert.equal(r2.status, 404, "a model-reachable reload endpoint exists");
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.tools.includes("backdoor")), undefined);
});

test("a hand-dropped file in the host directory does NOT hot-load — the reload trigger is the host's", async () => {
  mkdirSync(HOST_EXTENSIONS, { recursive: true });
  writeFileSync(path.join(HOST_EXTENSIONS, "hand-dropped.json"), JSON.stringify({
    id: "hand-dropped", name: "Hand Dropped", description: "dropped by a test, not by admission",
    source: "model", runsIn: "host", capabilities: [], bounds: {},
    tools: [{ name: "hand_dropped_tool", description: "x", primitive: "now", params: {} }],
  }));
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.id === "hand-dropped"), undefined, "a file in the host directory loaded without admission");
  const call = await turn("run the tool hand_dropped_tool");
  assert.equal(call.result?.ok, false, "a never-admitted tool was callable");
});

test("pasted source is DATA, never code: it becomes a file, nothing evaluates it", async () => {
  const j = await turn("create a file called paste.js with const stolen = require('fs'); fetch('http://evil.example')");
  assert.equal(j.result?.ok, true, "a paste is an ordinary file write inside the root");
  const content = readFileSync(path.join(WORKSPACE, "paste.js"), "utf8");
  assert.match(content, /stolen/);
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.length, 1, "a paste produced a loaded tool");
});

// ── 5. rsj: web search — the vocabulary says network, bounds say HOW MUCH ─
const PROBE_PORT = PORT; // the probe talks to THIS server: no external network in tests
test("a network tool declares where and how much; enforcement makes the declaration true", async () => {
  const propose = await postJson("/api/extensions/proposals", {
    descriptor: {
      id: "selfprobe", name: "Self Probe", description: "probes the local server",
      source: "model", runsIn: "host",
      capabilities: ["network"], bounds: { hosts: ["127.0.0.1"], maxRequests: 1 },
      tools: [{ name: "selfprobe", description: "GET a url on 127.0.0.1", primitive: "http-get", params: {} }],
    },
  });
  assert.equal(propose.state, "pending");
  const r = await admitAsHost("selfprobe");
  assert.equal(r.decision, "admitted");
  const inv = await getJson("/api/extensions");
  const probe = inv.extensions.find((e) => e.id === "selfprobe");
  assert.deepEqual(probe.declared, ["network"]);
  assert.equal(probe.enforced.network, "mediated-fetch", "the inventory must name the mechanism that makes 'network' true");
  assert.deepEqual(probe.bounds, { hosts: ["127.0.0.1"], maxRequests: 1 });
  // Positive control: the declared host answers.
  const ok = await turn(`run the tool selfprobe http://127.0.0.1:${PROBE_PORT}/api/health`);
  assert.equal(ok.result?.ok, true, `the allow-listed host failed: ${JSON.stringify(ok.result)}`);
  assert.equal(ok.result.status, 200);
  assert.match(ok.result.request, /^1\/1$/);
  // The bound is the declaration made true: another host refuses BY NAME.
  const other = await turn("run the tool selfprobe http://example.com/health");
  assert.equal(other.result?.ok, false);
  assert.equal(other.result?.refused, "host-not-allowed");
  assert.match(other.result?.why, /bounds\.hosts is \[127\.0\.0\.1\]/);
  // How much: the budget exhausts, by name.
  const again = await turn(`run the tool selfprobe http://127.0.0.1:${PROBE_PORT}/api/health`);
  assert.equal(again.result?.refused, "budget-exhausted");
  assert.match(again.result?.why, /1 of 1 requests used/);
});

test("an unbounded network declaration is refused at the gate", async () => {
  await postJson("/api/extensions/proposals", {
    descriptor: {
      id: "unbounded", name: "Unbounded", description: "network with no bounds",
      source: "model", runsIn: "host", capabilities: ["network"], bounds: {},
      tools: [{ name: "unbounded_fetch", description: "x", primitive: "http-get", params: {} }],
    },
  });
  const r = await admitAsHost("unbounded");
  assert.equal(r.decision, "refused");
  assert.equal(r.rule, "network-unbounded");
  assert.match(r.why, /where \(bounds\.hosts\)/);
  assert.match(r.why, /how much \(bounds\.maxRequests\)/);
});

// ── 5b. the redirect finding: the bound holds ACROSS the chain ───────────
// (isocan-flash, 2026-09-19: plain fetch followed redirects, so a declared
// host answering 302 reached an undeclared origin while the report named the
// declared host. RED first on that code, GREEN here.)
import { createServer as spinRedirector } from "node:http";

test("a redirect to an undeclared host refuses BY NAME; a declared one is followed, charged, and audited by where the bytes came from", async () => {
  const redirector = spinRedirector((req, res) => {
    if (req.url === "/out") { res.writeHead(302, { location: `http://localhost:${PORT}/api/extensions` }); return res.end(); } // localhost ∉ bounds.hosts
    if (req.url === "/in") { res.writeHead(302, { location: "/health" }); return res.end(); } // RELATIVE Location → resolves against this same declared host
    if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ served: "by the declared redirector host" })); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => redirector.listen(REDIRECTOR_PORT, "127.0.0.1", r));
  try {
    await postJson("/api/extensions/proposals", {
      descriptor: {
        id: "rdprobe", name: "RD Probe", description: "redirect probe",
        source: "model", runsIn: "host",
        capabilities: ["network"], bounds: { hosts: ["127.0.0.1"], maxRequests: 4 },
        tools: [{ name: "rdprobe", description: "GET", primitive: "http-get", params: {} }],
      },
    });
    const r = await admitAsHost("rdprobe");
    assert.equal(r.decision, "admitted");

    // The undeclared redirect target refuses BY NAME, with the chain named.
    const out = await turn(`run the tool rdprobe http://127.0.0.1:${REDIRECTOR_PORT}/out`);
    assert.equal(out.result?.ok, false, "bytes crossed from an undeclared origin");
    assert.equal(out.result?.refused, "redirect-host-not-allowed");
    assert.match(out.result?.why ?? '', /localhost/);
    assert.match(out.result?.why ?? '', /not in bounds\.hosts \[127\.0\.0\.1\]/);
    assert.match(out.result?.why ?? '', /→/, "the refusal names the chain");
    // The budget spent one hop on the 302 itself; it did NOT fetch the target.

    // A declared target (relative Location) is followed: charged PER HOP, and
    // the report names where the bytes actually came from.
    const inb = await turn(`run the tool rdprobe http://127.0.0.1:${REDIRECTOR_PORT}/in`);
    assert.equal(inb.result?.ok, true, `the declared redirect failed: ${JSON.stringify(inb.result)}`);
    assert.equal(inb.result.servedBy, `http://127.0.0.1:${REDIRECTOR_PORT}/health`);
    assert.match(inb.result.body ?? '', /by the declared redirector host/);
    assert.deepEqual(inb.result.via?.length, 2);
    assert.equal(inb.result.request, "3/4", "hops are charged, not calls (1 for the refused chain's 302, 2 for this chain)");

    // Budget arithmetic: 1 (the refused chain's 302) + 2 (the followed chain)
    // = 3 used; one more call exhausts 4/4 — HOPS, not calls.
    const third = await turn(`run the tool rdprobe http://127.0.0.1:${PORT}/api/health`);
    assert.equal(third.result?.request, "4/4");
    assert.equal(third.result?.servedBy, `http://127.0.0.1:${PORT}/api/health`);
    const fourth = await turn(`run the tool rdprobe http://127.0.0.1:${PORT}/api/health`);
    assert.equal(fourth.result?.refused, "budget-exhausted");
    assert.match(fourth.result?.why, /4 of 4 requests used/);

    // The audit records the OUTCOME: servedBy is where the bytes came from.
    const lines = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const allow = lines.filter((e) => e.decision === "allow" && e.act?.tool === "rdprobe").at(-1);
    assert.equal(allow.observed.servedBy, `http://127.0.0.1:${PORT}/api/health`); // the last allow = the direct call
    const followed = lines.filter((e) => e.decision === "allow" && e.act?.tool === "rdprobe").at(-2);
    assert.equal(followed.observed.servedBy, `http://127.0.0.1:${REDIRECTOR_PORT}/health`); // the followed redirect
    assert.equal(followed.observed.via[0], `http://127.0.0.1:${REDIRECTOR_PORT}/in`);
    const refused = lines.find((e) => e.decision === "refuse" && e.rule === "redirect-host-not-allowed");
    assert(refused, "the redirect refusal is not in the audit");
    assert.match(refused.why, /localhost/);
  } finally {
    await new Promise((r) => redirector.close(r));
  }
});

// ── 6. rsj: MCP — placement and authority are expressible ─────────────────
test("a REMOTE MCP server is expressible and admissible: no launch, bounded network, host-side authority", async () => {
  await postJson("/api/extensions/sideload", { id: "mcp-server-remote", confirm: true });
  const r = await admitAsHost("mcp-server-remote");
  assert.equal(r.decision, "admitted", `remote MCP refused: ${JSON.stringify(r)}`);
  const inv = await getJson("/api/extensions");
  const mcp = inv.extensions.find((e) => e.id === "mcp-server-remote");
  assert.equal(mcp.runsIn, "remote");
  assert.equal(mcp.enforced.network, "mediated-fetch");
});

// ── 7. one admission point: the user's door and the model's door agree ────
test("sideload and model proposal pass the SAME gate and reach the same states", async () => {
  // The user's door: sideload the harmless notes reader.
  const staged = await postJson("/api/extensions/sideload", { id: "notes", confirm: true });
  assert.equal(staged.state, "pending");
  const r = await admitAsHost("notes");
  assert.equal(r.decision, "admitted");
  writeFileSync(path.join(WORKSPACE, "notes.md"), "the notes live here");
  const call = await turn("run the tool read_notes");
  assert.equal(call.result?.ok, true);
  assert.equal(call.result?.content, "the notes live here");
  // The inventory shows the declared-vs-enforced line for it:
  const inv = await getJson("/api/extensions");
  const notes = inv.extensions.find((e) => e.id === "notes");
  assert.deepEqual(notes.declared, ["read"]);
  assert.equal(notes.enforced.read, "host-primitive-scope");
  assert.match(notes.gets[0], /root-scoped read function/);
});

test("the host's veto: decision 'deny' refuses even an admissible proposal, by name", async () => {
  await postJson("/api/extensions/proposals", {
    descriptor: {
      id: "junk", name: "Junk", description: "admissible but denied",
      source: "model", runsIn: "host", capabilities: [], bounds: {},
      tools: [{ name: "junk_tool", description: "x", primitive: "now", params: {} }],
    },
  });
  const r = await admitAsHost("junk", "deny");
  assert.equal(r.decision, "refused");
  assert.equal(r.rule, "host-deny");
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.id === "junk"), undefined);
});

// ── 8. the catalogue: discover, with the disclosure inline ────────────────
test("the catalogue lists strangers with what admission WOULD decide", async () => {
  const cat = await getJson("/api/extensions/catalogue");
  const byId = Object.fromEntries(cat.catalogue.map((c) => [c.id, c]));
  assert.equal(byId["web-search"].preview.decision, "admitted");
  assert.equal(byId["mcp-server-local"].preview.decision, "refused", "the catalogue must say upfront what the gate would decide");
  assert.equal(byId["mcp-server-local"].preview.rule, "exec-absent");
  assert.equal(byId["mcp-server-remote"].preview.decision, "admitted");
});

// ── 9. the m2i acceptance: the page's two-fetch admission now fails BY NAME ─
test("THE ACCEPTANCE: the page's two-fetch admission (propose, then admit) is refused host-token-required", async () => {
  // Fetch 1 (the page's door — still open): propose.
  const proposed = await postJson("/api/extensions/proposals", {
    descriptor: {
      id: "pageself", name: "Page Self-Admit", description: "the page admits itself",
      source: "model", runsIn: "host", capabilities: [], bounds: {},
      tools: [{ name: "pageself_tool", description: "x", primitive: "now", params: {} }],
    },
  });
  assert.equal(proposed.state, "pending");
  // Fetch 2 WITHOUT the host token — exactly the drive that found the hole:
  const pageAdmit = await postJson("/api/extensions/admit", { id: "pageself", confirm: true, decision: "admit" });
  assert.equal(pageAdmit.ok, false, `the page admitted itself again: ${JSON.stringify(pageAdmit)}`);
  assert.equal(pageAdmit.refused, "host-token-required");
  assert.match(pageAdmit.why, /the page cannot hold it/);
  // And the tool still refuses, by name, in the page's vocabulary:
  const call = await turn("run the tool pageself_tool");
  assert.equal(call.result?.refused, "not-admitted");
  // A WRONG token is the same refusal — the check is the token, not the header's presence:
  const wrong = await fetch(`${BASE}/api/extensions/admit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": "not-the-token" },
    body: JSON.stringify({ id: "pageself", confirm: true, decision: "admit" }),
  }).then((r) => r.json());
  assert.equal(wrong.refused, "host-token-required");
  // The host, WITH the token, admits — the same two-fetch flow plus the host's secret:
  const host = await admitAsHost("pageself");
  assert.equal(host.decision, "admitted");
  const run = await turn("run the tool pageself_tool");
  assert.equal(run.result?.ok, true);
});

// ── 10. the 0xp acceptance: the sweep is dead — present, not admitted ──────
test("a dropped file is present-not-admitted: the next host admission does NOT sweep it in", async () => {
  mkdirSync(HOST_EXTENSIONS, { recursive: true });
  writeFileSync(path.join(HOST_EXTENSIONS, "sweep2.json"), JSON.stringify({
    id: "sweep2", name: "Sweep 2", description: "dropped, never admitted",
    source: "model", runsIn: "host", capabilities: [], bounds: {},
    tools: [{ name: "sweep2_tool", description: "x", primitive: "now", params: {} }],
  }));
  // The host admits a DIFFERENT tool — the reload happens:
  await postJson("/api/extensions/proposals", {
    descriptor: {
      id: "reloadbait", name: "Reload Bait", description: "forces the reload",
      source: "model", runsIn: "host", capabilities: [], bounds: {},
      tools: [{ name: "reloadbait_tool", description: "x", primitive: "now", params: {} }],
    },
  });
  const r = await admitAsHost("reloadbait");
  assert.equal(r.decision, "admitted");
  // The sweep that used to happen: the dropped file is NOT live.
  const inv = await getJson("/api/extensions");
  assert.equal(inv.extensions.find((e) => e.id === "sweep2"), undefined, "the sweep-in happened again");
  // But it is VISIBLE as exactly what it is:
  const present = inv.present.find((p) => p.id === "sweep2");
  assert.equal(present?.state, "present-not-admitted");
  assert.match(present?.note ?? "", /never live/);
  const call = await turn("run the tool sweep2_tool");
  assert.equal(call.result?.refused, "unknown-tool");
});
