import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("Work Activity log and enriched Changelog API", async (t) => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "voicebox-activity-test-"));
  const srv = await startServer();
  t.after(async () => {
    await srv.stop();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  await t.test("GET /api/activity returns initial array", async () => {
    const res = await fetch(`${srv.base}/api/activity`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.entries));
  });

  await t.test("POST /api/root records a project activity entry", async () => {
    const rootRes = await fetch(`${srv.base}/api/root`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voicebox-host-token": srv.hostToken,
      },
      body: JSON.stringify({
        project: "activity-demo",
        root: { kind: "machine", path: scratchDir },
      }),
    });
    assert.equal(rootRes.status, 200);

    const actRes = await fetch(`${srv.base}/api/activity`);
    const actData = await actRes.json();
    assert.equal(actData.ok, true);
    const projectEntry = actData.entries.find((e) => e.kind === "project");
    assert.ok(projectEntry, "expected a project activity entry");
    assert.match(projectEntry.summary, /Active project root set to/);
    assert.equal(projectEntry.detail, "activity-demo");
    assert.equal(projectEntry.status, "ok");
  });

  await t.test("File write turn and command execution record file and command activity entries", async () => {
    const turnRes = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "create a file called hello.txt with hi" }),
    });
    assert.equal(turnRes.status, 200);

    const execRes = await fetch(`${srv.base}/api/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "node --version" }),
    });
    assert.equal(execRes.status, 200);

    const actRes = await fetch(`${srv.base}/api/activity`);
    const actData = await actRes.json();
    assert.equal(actData.ok, true);

    const fileEntry = actData.entries.find((e) => e.kind === "file" && e.file === "hello.txt");
    assert.ok(fileEntry, "expected a file activity entry for hello.txt");
    assert.match(fileEntry.summary, /write: hello\.txt/);
    assert.equal(fileEntry.status, "ok");

    const cmdEntry = actData.entries.find((e) => e.kind === "command" && /node --version/.test(e.summary));
    assert.ok(cmdEntry, "expected a command activity entry for node --version");
    assert.equal(cmdEntry.status, "ok");
  });

  await t.test("DELETE /api/activity clears the activity buffer", async () => {
    const delRes = await fetch(`${srv.base}/api/activity`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.ok, true);
    assert.deepEqual(delData.entries, []);

    const actRes = await fetch(`${srv.base}/api/activity`);
    const actData = await actRes.json();
    assert.equal(actData.entries.length, 0);
  });

  await t.test("GET /api/changelog returns enriched commit entries with category, description, stats, and files", async () => {
    const res = await fetch(`${srv.base}/api/changelog`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.commits));
    assert.ok(data.commits.length > 0, "expected at least one commit in changelog");
    const first = data.commits[0];
    assert.equal(typeof first.sha, "string");
    assert.equal(typeof first.shortSha, "string");
    assert.equal(typeof first.subject, "string");
    assert.equal(typeof first.category, "string");
    assert.equal(typeof first.description, "string");
    assert.equal(typeof first.body, "string");
    assert.ok(first.stats && typeof first.stats === "object");
    assert.equal(typeof first.stats.filesChanged, "number");
    assert.equal(typeof first.stats.insertions, "number");
    assert.equal(typeof first.stats.deletions, "number");
    assert.ok(Array.isArray(first.files));
  });
});
