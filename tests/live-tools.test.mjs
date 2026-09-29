// tests/live-tools.test.mjs — THE ACCEPTANCE PAUL RUNS, automated:
// ask the live voice to write a file, then read that file from disk and
// compare byte for byte; then ask it to read a file ONLY THE TEST KNOWS and hear
// its words spoken (via the output transcription) — the read half is proved by
// words no turn ever told the session (voicebox-beads-cx16).
//
// Real Gemini Live, real executor, real filesystem. No stubs. Skipped only
// when there is no key — a green run here IS the driven evidence.
//
//   GEMINI_API_KEY=... node --test tests/live-tools.test.mjs
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const HAVE_KEY = Boolean(process.env.GEMINI_API_KEY);

// A FREE PORT PER SERVER, the fleet rule (2026-09-20: fixed ports collide with
// other lanes' runs, and a suite that reports on its environment is not a
// gate). Bind 0, read the number, release, hand it over — the same pattern
// scripts/docs-check.mjs uses, with the same TOCTOU caveat.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-live-tools-"));
// The workspace must EXIST: VOICEBOX_WORKSPACE is a declaration, and declaring
// a missing directory is refused at boot ("no root is declared"), which turns
// this acceptance into the refusal test's shape by accident.
const WORKSPACE = path.join(SCRATCH, "workspace");
mkdirSync(WORKSPACE, { recursive: true });

function startServer(port, env = {}) {
  const proc = spawn("node", ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), VOICEBOX_RESOLVER: "script", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return proc;
}

function waitForServer(proc, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), ms);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("voicebox on")) { clearTimeout(t); resolve(); }
    });
  });
}

async function liveSocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const states = [];
  const texts = [];
  const tools = [];
  let audioBytes = 0;
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.type === "state") states.push(m);
      if (m.type === "text") texts.push(m);
      if (m.type === "tool") tools.push(m);
    } else {
      audioBytes += e.data.byteLength;
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  // Wait for the readiness gate to open.
  for (let i = 0; i < 100; i++) {
    if (states.some((s) => s.state === "ready")) break;
    await sleep(200);
    if (i === 99) throw new Error("the live session never became ready");
  }
  return { ws, states, texts, tools, audio: () => audioBytes };
}

/**
 * THE MODEL IS NOT THE THING UNDER TEST (voicebox-beads-cx16 — the same instrument defect k6uu fixed in
 * tests/page-writes.test.mjs, and this file's sibling of that fix). This suite proves the LIVE TOOL PATH:
 * the model calls a tool, the server executes it against the machine root, and the answer comes back. The
 * model in the middle is nondeterministic: it can skip a tool call, or answer a read request out of the
 * conversation instead of reading, and a test that waits for it to SAY something it already knew then
 * asserts a tool call that was never made — a pass that can happen without the behaviour, and a red that
 * says "the model did not read" when the truth is "the model did not read THIS WAY".
 *
 * The read half is therefore proved by words the session has never seen (below), and every leg that hinges
 * on the model choosing a tool is asked again in a CORRECTED form, bounded, with the ask count in the
 * failure message — so a reviewer can tell a language model's mood from a broken route.
 */
const LIVE_ASKS = 3;
const LIVE_ASK_MS = 15000;

/** Words a speech transcriber handles, and a model reading a file cannot guess. */
const READ_WORDS = ["saffron", "pelican", "quartz", "walnut", "lantern", "cobalt", "tundra", "meadow", "harbour", "marble"];
const pickWords = (count) => {
  const pool = [...READ_WORDS];
  const picked = [];
  while (picked.length < count) picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  return picked;
};

/** One live text turn, waited on for a NAMED condition the caller states. */
async function liveAsk(ws, text, settled, ms = LIVE_ASK_MS) {
  ws.send(JSON.stringify({ type: "text", text }));
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(200);
    if (settled()) return true;
  }
  return settled();
}

test("live tools: the model writes a file we read byte-for-byte, then reads back words it never saw", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 180000 }, async () => {
  const port = await freePort();
  const server = startServer(port, { VOICEBOX_WORKSPACE: WORKSPACE });
  try {
    await waitForServer(server);
    const { ws, texts, tools, audio } = await liveSocket(port);

    // 1. WRITE — the model must choose write_file and the file must land. A skipped tool call is asked
    // again in a corrected form (bounded): the thing under test is the tool path, not one model turn.
    const target = path.join(WORKSPACE, "live-note.txt");
    const writeCall = () => tools.flatMap((t) => t.calls).find((c) => c.name === "write_file" && c.ok);
    const writePrompt = (attempt) => attempt === 0
      ? "Please create a file called live-note.txt with the exact content: the live path wrote this"
      : 'Call the write_file tool with name "live-note.txt" and content "the live path wrote this" — create the file itself.';
    const wrote = () => Boolean(writeCall()) && existsSync(target);
    let writeAsks = 0;
    for (; writeAsks < LIVE_ASKS && !wrote(); writeAsks++) await liveAsk(ws, writePrompt(writeAsks), wrote);
    assert(existsSync(target), `the live turn produced no file in ${writeAsks} ask(s) — the tool was not called`);
    const onDisk = readFileSync(target, "utf8");
    assert.equal(onDisk, "the live path wrote this", `byte-for-byte compare failed: ${JSON.stringify(onDisk)}`);
    assert(writeCall(), "the page-visible tool event did not report the write");

    // 2. READ — the model must call read_file and SPEAK words the session has never seen. The first version
    // of this leg waited for the model to say "the live path wrote this" — a phrase step 1 handed it — and a
    // model that answered from the conversation satisfied that wait WITHOUT reading, so the read_file
    // assertion that followed went red: a flake whose cause was the instrument. The fixture below is written
    // by the test into the workspace the server acts on, with three words drawn at random, so the only way
    // the model can speak them is a real read of a real file.
    const [wordA, wordB, wordC] = pickWords(3);
    const fixtureName = "read-back-proof.txt";
    writeFileSync(path.join(WORKSPACE, fixtureName), `the ${fixtureName} says ${wordA} ${wordB} ${wordC}`);

    const readCall = () => tools.flatMap((t) => t.calls).find((c) => c.name === "read_file" && c.ok);
    const heard = () => texts.map((t) => t.text).join(" ").replace(/\s+/g, " ");
    const heardWords = () => [wordA, wordB, wordC].filter((w) => new RegExp(`\\b${w}\\b`, "i").test(heard()));
    // A CORRECTED ASK, NOT A REPEAT (and a PLAIN NAME, because the tool's own contract is "Use a plain file
    // name, no directories"): a model that reached for the wrong argument rarely reaches for the right one
    // because it was asked the same way twice.
    const readPrompt = (attempt) => {
      if (attempt === 0) return `Read ${fixtureName} back to me and tell me exactly what it says — do not guess.`;
      const refused = tools.flatMap((t) => t.calls).filter((c) => c.name === "read_file" && !c.ok).at(-1);
      return refused
        ? `The read_file call for ${fixtureName} was refused (${refused.action ?? "refused"}). Call read_file with the plain file name "${fixtureName}" — and tell me what the file says.`
        : `Call the read_file tool with the plain file name "${fixtureName}" — and tell me what the file says.`;
    };
    const audioBefore = audio();
    const answered = () => Boolean(readCall()) && heardWords().length >= 2;
    let readAsks = 0;
    for (; readAsks < LIVE_ASKS && !answered(); readAsks++) await liveAsk(ws, readPrompt(readAsks), answered);
    // The spoken words are the WITNESS: they cannot be produced by an answer from context, so a route that
    // broke shows up here as words that never came — and the message says how many asks were spent.
    assert(
      heardWords().length >= 2,
      `the model spoke ${heardWords().length} of the fixture's own words after ${readAsks} ask(s), so no read can be claimed (wanted 2+) — heard: ${heard().slice(-200)}`,
    );
    assert(readCall(), `the model did not call read_file with an ok answer in ${readAsks} ask(s) — calls seen: ${JSON.stringify(tools.flatMap((t) => t.calls).map((c) => [c.name, c.ok]))}`);
    assert(audio() > audioBefore, "no audio came back for the read answer — the answer was not spoken");

    ws.close();
  } finally {
    server.kill("SIGKILL");
  }
});

test("live tools: with no root declared the refusal is SPOKEN, not swallowed", { skip: !HAVE_KEY && "GEMINI_API_KEY not set", timeout: 120000 }, async () => {
  // No VOICEBOX_WORKSPACE and no POST /api/root: the executor refuses by name.
  const port = await freePort();
  const server = startServer(port);
  try {
    await waitForServer(server);
    const { ws, texts, tools } = await liveSocket(port);

    ws.send(JSON.stringify({ type: "text", text: "Create a file called anything.txt with hello" }));
    let said = "";
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      said = texts.map((t) => t.text).join(" ");
      if (tools.length && /root|declared|can't|cannot|unable/i.test(said)) break;
    }
    const writeCall = tools.flatMap((t) => t.calls).find((c) => c.name === "write_file");
    assert(writeCall, "the model did not attempt the write");
    assert.equal(writeCall.ok, false, "with no root declared the write must be refused");
    assert.match(said, /root|declared|can't|cannot|unable/i, `the refusal was not spoken — heard: ${said.slice(0, 160)}`);

    ws.close();
  } finally {
    server.kill("SIGKILL");
  }
});

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));
