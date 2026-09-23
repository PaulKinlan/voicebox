// TWO CONCEPTS, TWO NAMES — and the old names keep working, out loud.
//
// The pair `VOICEBOX_PROVIDER` / `LIVE_PROVIDER` read as though the second were the live-mode sibling of
// the first. They are not: one selects the TURN RESOLVER (the brain that answers POST /api/turn), the
// other the LIVE TRANSPORT's fallback provider. It misled in practice — tests/lib/server.mjs records a
// voice-path developer exporting `VOICEBOX_PROVIDER=live`, which put "live" in the RESOLVER slot and
// stopped turns writing.
//
// So the names now say which half of the system they belong to, and this file is the promise that the old
// ones did not simply stop working: an exported `VOICEBOX_PROVIDER`/`LIVE_PROVIDER` is honoured for one
// release, says so on stderr, and loses to the new name when both are set. Without this test the
// deprecation is a comment; with it, it is a contract somebody can rely on and a thing a later release
// can remove deliberately.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Boot the real server with an exact environment and read what it says it resolved. */
async function bootWith(env, { port = 0 } = {}) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-envnames-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      VOICEBOX_EXTENSIONS_DIR: scratch,
      VOICEBOX_WORKSPACE: undefined,
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "",
      // Blanked here as well as set explicitly below, so a developer's shell cannot decide the result.
      VOICEBOX_RESOLVER: undefined,
      VOICEBOX_PROVIDER: undefined,
      VOICEBOX_LIVE_PROVIDER: undefined,
      LIVE_PROVIDER: undefined,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));

  const deadline = Date.now() + 20000;
  let base = null;
  while (Date.now() < deadline) {
    const m = out.match(/voicebox on (http:\/\/[^\s]+)/);
    if (m) { base = m[1]; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = async () => { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; rmSync(scratch, { recursive: true, force: true }); };
  if (!base) { const why = err || out || "(no output)"; await stop(); throw new Error(`server did not report a bound port: ${why}`); }
  return { base, out, err, stop };
}

test("the resolver's new name is read, and reported as the provider the process uses", async (t) => {
  const s = await bootWith({ VOICEBOX_RESOLVER: "gemini" });
  t.after(s.stop);
  const health = await (await fetch(`${s.base}/api/health`)).json();
  assert.equal(health.provider, "gemini", "VOICEBOX_RESOLVER was not read as the turn resolver");
  assert.doesNotMatch(s.err, /is now VOICEBOX_RESOLVER/, "the deprecation line was printed for a name that is current");
});

test("the resolver's OLD name still works, and says so out loud", async (t) => {
  const s = await bootWith({ VOICEBOX_PROVIDER: "gemini" });
  t.after(s.stop);
  const health = await (await fetch(`${s.base}/api/health`)).json();
  assert.equal(health.provider, "gemini", "the old name was silently dropped — a shell that exports it would break");
  assert.match(s.err, /VOICEBOX_PROVIDER is now VOICEBOX_RESOLVER/, "no line told the operator their variable was renamed");
  assert.match(s.err, /it selects the turn resolver, not the live provider/, "the line does not say which concept it belongs to");
});

test("when both resolver names are set the NEW one wins, so a stale export cannot override a current one", async (t) => {
  const s = await bootWith({ VOICEBOX_RESOLVER: "gemini", VOICEBOX_PROVIDER: "script" });
  t.after(s.stop);
  const health = await (await fetch(`${s.base}/api/health`)).json();
  assert.equal(health.provider, "gemini", "the old name overrode the new one");
  assert.match(s.err, /is now VOICEBOX_RESOLVER/, "the operator was not told the old name was being ignored");
});

test("the LIVE provider's old and new names both resolve to the same registered provider", async () => {
  // The live fallback is a library rule, so it is read from the library rather than the server: a name
  // that is honoured in one place and dropped in another is how a rename breaks a shell silently.
  const { resolvedLiveProviderName } = await import("../lib/live-session.mjs");
  const saved = { newName: process.env.VOICEBOX_LIVE_PROVIDER, oldName: process.env.LIVE_PROVIDER };
  try {
    delete process.env.VOICEBOX_LIVE_PROVIDER; delete process.env.LIVE_PROVIDER;
    assert.equal(resolvedLiveProviderName(), "gemini", "the library's own default changed");
    process.env.LIVE_PROVIDER = "openai";
    assert.equal(resolvedLiveProviderName(), "openai", "the old live-provider name was dropped");
    process.env.VOICEBOX_LIVE_PROVIDER = "gemini";
    assert.equal(resolvedLiveProviderName(), "gemini", "the new live-provider name did not win over the old one");
    assert.equal(resolvedLiveProviderName("openai"), "openai", "an explicit provider no longer beats both names");
  } finally {
    if (saved.newName === undefined) delete process.env.VOICEBOX_LIVE_PROVIDER; else process.env.VOICEBOX_LIVE_PROVIDER = saved.newName;
    if (saved.oldName === undefined) delete process.env.LIVE_PROVIDER; else process.env.LIVE_PROVIDER = saved.oldName;
  }
});
