// tests/two-agents.test.mjs — two agents on one project, each seeing the other live.
//
//   node --test tests/two-agents.test.mjs
//
// THE CLAIM BEING DRIVEN (N19 / §9): two agents see each other's PRESENCE, what each is DOING, and
// what each has READ — as it happens, from the log, before any merge. That is what "the merge stops
// being the coordination channel and becomes the landing step" means, and it is the half the E1-M0
// per-root audit did not have.
//
// Two workers in one origin. Two workers are two agents: separate instances with separate files in
// the same root's `.audit/`, appending and reading each other's entries. THE HONEST LIMIT, named
// rather than implied: OPFS is shared by construction, so this proves the LOG's semantics (append
// only, instance-tagged, marks converging, liveness measured at read time) — not a transport between
// two machines, which is E2's and is not built. Two machines would append to different storage and
// meet at the same merge; nothing in the shape changes when they do.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8835;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = "atlas";

let server;
let page;

/** The page's own agent (the UI worker). */
const me = (message) => page.evaluate((m) => window.e1m0.send(m), message);

/** A second agent: its own worker, its own instance, its own session. */
const agent = (message) => page.evaluate((m) => window.__agent.send(m), message);

test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    await sleep(100);
  }
  page = await launch();
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
});

test.after(async () => {
  await page?.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
});

test("two agents see each other's presence, work, and read positions — live, before any merge", { timeout: 120000 }, async () => {
  // Agent A: the page's own worker, doing real work in the project.
  const opened = await me({ type: "openProject", name: PROJECT });
  assert.equal(opened.ok, true, `the first agent could not open the project: ${JSON.stringify(opened)}`);
  const wrote = await me({ type: "createAsset", args: { name: "from-phone.txt", kind: "text", body: "phone was here" } });
  assert.equal(wrote.ok, true, "the first agent could not write");

  // Agent B: a second worker, named, with its own session — §9's actor model, driven.
  const identified = await page.evaluate(async (name) => {
    const worker = new Worker("/browser/worker.ts", { type: "module" });
    const waiters = new Map();
    const progress = [];
    worker.onmessage = (event) => {
      const data = event.data;
      if (data && data.id && waiters.has(data.id)) {
        waiters.get(data.id)(data);
        waiters.delete(data.id);
      } else {
        progress.push(data);
      }
    };
    let next = 1;
    const send = (message) => new Promise((resolve) => {
      const id = next++;
      waiters.set(id, resolve);
      worker.postMessage({ ...message, id });
    });
    window.__agent = { worker, send, progress };
    return await send({
      type: "identify",
      instance: "laptop",
      actor: { name: "laptop", harness: "pi", session: "01a0b381-d2f1", cwd: "/home/paulkinlan/voicebox-e1m0" },
    });
  }, "laptop");
  assert.equal(identified.ok, true, "the second agent could not identify itself");
  assert.equal(identified.instance, "laptop");
  assert.equal(identified.actor.session, "01a0b381-d2f1", "the second agent lost its session identity");

  const joined = await agent({ type: "openProject", name: PROJECT });
  assert.equal(joined.ok, true, `the second agent could not open the project: ${JSON.stringify(joined)}`);

  // B looks: it sees A's presence and what A is doing, WITHOUT anything having been merged.
  const firstLook = await agent({ type: "look" });
  assert.equal(firstLook.ok, true, `the second agent could not look: ${JSON.stringify(firstLook)}`);
  const phone = firstLook.agents.find((a) => a.instance === "phone");
  assert.ok(phone, `the second agent cannot see the first: ${JSON.stringify(firstLook.agents)}`);
  assert.equal(phone.reported, "ready", "the first agent's presence is not visible");
  assert.ok(
    firstLook.doing.some((d) => d.instance === "phone" && /creating text asset/.test(d.doing)),
    `the second agent cannot see what the first is doing: ${JSON.stringify(firstLook.doing)}`,
  );

  // THE PAIR THAT WOULD COLLAPSE: "it has not run yet" versus "it has run and read nothing".
  // At this moment phone has acted but never looked, so what phone knows is UNKNOWN — not empty.
  const beforePhoneLooked = firstLook.knew.find((k) => k.instance === "phone");
  assert.equal(beforePhoneLooked.mark, null, "an agent that never looked was reported as knowing nothing");

  // phone looks: now it has marks, and the other agent can read them.
  const phoneLook = await me({ type: "look" });
  assert.equal(phoneLook.ok, true, `the first agent could not look: ${JSON.stringify(phoneLook)}`);
  assert.ok(phoneLook.claimed.length > 0, "looking claimed no positions, so 'what did it know' stays unanswerable");

  const secondLook = await agent({ type: "look", mark: false });
  const phoneMark = secondLook.knew.find((k) => k.instance === "phone").mark;
  assert.notEqual(phoneMark, null, "the first agent's read positions are still invisible after it looked");
  assert.ok(
    Object.keys(phoneMark).length > 0,
    `the mark does not name the writers it had read: ${JSON.stringify(phoneMark)}`,
  );
  // A mark is a position PER WRITER — the version-vector shape two machines can actually converge
  // on — so it can never be a position in "the merged log", which has no such sequence.
  for (const [writer, upto] of Object.entries(phoneMark)) {
    assert.equal(typeof writer, "string");
    assert.equal(Number.isInteger(upto), true, `a mark for ${writer} is not a position in that writer's sequence`);
  }

  // B does work. A's next look shows it as UNSEEN, grouped by writer — and A's own work is not
  // offered back to it as something it owes itself.
  const laptopWrote = await agent({ type: "createAsset", args: { name: "from-laptop.txt", kind: "text", body: "laptop was here" } });
  assert.equal(laptopWrote.ok, true, "the second agent could not write");

  const thirdLook = await me({ type: "look" });
  assert.notEqual(thirdLook.unseen, null, "an agent that has looked cannot have an unknown backlog");
  const fromLaptop = thirdLook.unseen.find((g) => g.writer === "laptop");
  assert.ok(fromLaptop, `the first agent cannot see the second's new work: ${JSON.stringify(thirdLook.unseen)}`);
  assert.ok(
    fromLaptop.entries.some((e) => e.act?.target?.endsWith("from-laptop.txt")),
    "the second agent's work is not in the first agent's backlog",
  );
  assert.equal(
    thirdLook.unseen.some((g) => g.writer === "phone"),
    false,
    "an agent was handed back its own work as something it had not seen",
  );
  // Each group is ordered by ITS OWN writer's sequence, and no group mixes writers: this is where a
  // global order would sneak in and be invisible.
  for (const group of thirdLook.unseen) {
    const seqs = group.entries.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `group ${group.writer} is not in its own order`);
    assert.equal(new Set(group.entries.map((e) => e.instance)).size, 1, `group ${group.writer} mixes writers`);
  }

  // And the second agent can see what the FIRST has read — the question the bead says a late merge
  // can only answer after the fact.
  const laptopLook = await agent({ type: "look" });
  const phoneMarkAfter = laptopLook.knew.find((k) => k.instance === "phone").mark;
  assert.ok(
    phoneMarkAfter.laptop >= 0,
    `the second agent cannot see what the first has read: ${JSON.stringify(phoneMarkAfter)}`,
  );

  // Both agents' entries are in one medium, one file per writer, and the merged read claims only
  // (instance, seq) — two independent sequences, no global order.
  const all = await page.evaluate(async () => {
    const reply = await window.e1m0.send({ type: "auditAll" });
    return reply.files.map((f) => ({
      name: f.name,
      entries: f.entries.length,
      instances: [...new Set(f.entries.map((e) => e.instance))],
      kinds: [...new Set(f.entries.map((e) => e.kind))].sort(),
    }));
  });
  const atlasLogs = all.filter((f) => f.instances.length > 0);
  assert.ok(atlasLogs.length >= 2, `expected one log per agent, saw ${JSON.stringify(all)}`);
  for (const log of atlasLogs) {
    assert.equal(log.instances.length, 1, `a per-root file holds two instances: ${JSON.stringify(log)}`);
    assert.ok(log.kinds.includes("act"), "a log with no acts in it is not the medium this claims");
  }

  const instanceFiles = new Set(all.filter((f) => f.instances.length === 1).map((f) => f.instances[0]));
  assert.deepEqual([...instanceFiles].sort(), ["laptop", "phone"], "the two agents do not have their own files");

  // And the PAGE shows it: the shared view is a panel, not a library function.
  await page.evaluate(async () => { await window.e1m0.open("atlas"); await window.e1m0.renderAgents(true); });
  const panel = await page.evaluate(() => document.getElementById("agents").textContent);
  assert.match(panel, /laptop/, "the page does not name the other agent");
  assert.match(panel, /read phone→/, "the page does not show what the other agent has read");
  assert.match(panel, /you are 'phone'/, "the page does not say which agent you are");
});

test("the shared view survives a reload, because it is storage and not memory", { timeout: 120000 }, async () => {
  await page.reload();
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the host API after reload" });
  const after = await page.evaluate(async () => {
    await window.e1m0.send({ type: "openProject", name: "atlas" });
    const view = await window.e1m0.send({ type: "look", mark: false });
    return { agents: view.agents.map((a) => a.instance), knew: view.knew };
  });
  assert.ok(after.agents.includes("laptop"), `the other agent is not in the reloaded log: ${JSON.stringify(after)}`);
  const laptopKnew = after.knew.find((k) => k.instance === "laptop");
  assert.notEqual(laptopKnew.mark, null, "the other agent's read positions did not survive the reload");
});
