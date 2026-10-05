// tests/path-auth-verbs.test.mjs — EVERY route-reachable file verb at a "." segment and a ".." escape, driven live.
//
// voicebox-beads-q0a3's acceptance, as written on the bead: "drive each verb at a '.' segment and a
// '..' escape; keep node scripts/single-owner.mjs enforcing the single computing site" — plus an
// allowed-path control per verb, because a refusal set with no control proves nothing about what
// still works. Every REST file route funnels through `execute()` → `resolveActive()` →
// lib/path-auth.mjs (the ONE owner this bead extracted); this file drives them over HTTP the way
// the room does. `mkdir` has no REST route (it arrives on the live turn path); its authorization is
// the same `resolveActive` call and is driven at the owner level in tests/path-auth.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

test("every file verb refuses a '.' dotfile segment and a '..' escape, and allows an ordinary path", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-path-auth-verbs-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(path.join(workspace, "sub"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "target.txt"), "line one\nline two\n");

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const base = server.base;

  // The dotfiles exist on disk — the refusals must be AUTHORIZATION's, not a not-found.
  fs.writeFileSync(path.join(workspace, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(workspace, "sub", ".env"), "SECRET=2\n");

  const put = (name, content) => fetch(`${base}/api/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, content }) }).then((r) => r.json());

  // ── write ───────────────────────────────────────────────────────────────────
  assert.equal((await put(".env", "pwned")).refused, "dotfile-refused", "write at a dotfile leaf refuses by name");
  assert.equal((await put("sub/.env", "pwned")).refused, "dotfile-refused", "write at a NESTED dotfile refuses (the page's old leaf-only copy allowed this)");
  assert.equal((await put("../evil.sh", "pwned")).refused, "outside-root", "write at a .. escape keeps the stronger refusal");
  assert.equal((await put("ctl-write.txt", "control")).ok, true, "the allowed write still works");
  assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "SECRET=1\n", "the dotfile was not touched");

  // ── read (GET /api/file) ────────────────────────────────────────────────────
  const readDot = await fetch(`${base}/api/file?name=${encodeURIComponent(".env")}`);
  assert.equal(readDot.status, 403);
  assert.equal((await readDot.json()).refused, "dotfile-refused");
  const readEsc = await fetch(`${base}/api/file?name=${encodeURIComponent("../evil.sh")}`);
  assert.equal((await readEsc.json()).refused, "outside-root");
  const readCtl = await fetch(`${base}/api/file?name=${encodeURIComponent("target.txt")}`);
  assert.equal(readCtl.status, 200, "the allowed read still works");

  // ── edit (PATCH /api/file) ──────────────────────────────────────────────────
  const patch = (name, oldText, newText) => fetch(`${base}/api/file`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, oldText, newText }) }).then((r) => r.json());
  assert.equal((await patch(".env", "SECRET", "PWNED")).refused, "dotfile-refused");
  assert.equal((await patch("../evil.sh", "a", "b")).refused, "outside-root");
  assert.equal((await patch("target.txt", "line one", "line uno")).ok, true, "the allowed edit still works");
  assert.match(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), /line uno/);

  // ── diff (POST /api/file/diff) ──────────────────────────────────────────────
  const diff = (name, content) => fetch(`${base}/api/file/diff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, content }) }).then((r) => r.json());
  assert.equal((await diff(".env", "x")).refused, "dotfile-refused");
  assert.equal((await diff("../evil.sh", "x")).refused, "outside-root");
  assert.equal((await diff("target.txt", "line uno\nline two\n")).ok, true, "the allowed diff still works");

  // ── delete (DELETE /api/file) ───────────────────────────────────────────────
  const del = (name) => fetch(`${base}/api/file?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) => r.json());
  assert.equal((await del(".env")).refused, "dotfile-refused");
  assert.equal((await del("../evil.sh")).refused, "outside-root");
  assert.equal((await del("ctl-write.txt")).ok, true, "the allowed delete still works");
  assert.equal(fs.existsSync(path.join(workspace, ".env")), true, "the dotfile survived every attempt on it");
  assert.equal(fs.existsSync(path.join(scratch, "evil.sh")), false, "nothing escaped the root");

  // ── list (GET /api/files) ───────────────────────────────────────────────────
  assert.equal((await (await fetch(`${base}/api/files?dir=${encodeURIComponent("sub/.hidden")}`)).json()).refused, "dotfile-refused", "list at a dotfile folder refuses by name");
  assert.equal((await (await fetch(`${base}/api/files?dir=${encodeURIComponent("../outside")}`)).json()).refused, "outside-root", "list at a .. escape refuses outside-root");
  const listCtl = await (await fetch(`${base}/api/files?dir=${encodeURIComponent("sub")}`)).json();
  assert.equal(listCtl.ok, true, "the allowed listing still works");
  assert.equal(listCtl.files.includes(".env"), false, "and the listing still hides dotfiles");

  // ── the mini-app store writer: save and delete through the same owner ───────
  const saveApp = (fileName) => fetch(`${base}/api/mini-apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "App", html: "<html><body>hi</body></html>", fileName }) }).then((r) => r.json());
  const saveDot = await saveApp(".hidden.html");
  assert.equal(saveDot.ok, false, "a dotfile mini-app save must refuse (it used to write what the listing hides)");
  assert.equal(saveDot.refused, "dotfile-refused");
  assert.equal(fs.existsSync(path.join(workspace, ".hidden.html")), false, "and nothing landed in the workspace");
  const saveCtl = await saveApp("visible.html");
  assert.equal(saveCtl.ok, true, `the allowed save must succeed (got ${JSON.stringify(saveCtl)})`);
  assert.equal(fs.existsSync(path.join(workspace, "visible.html")), true, "the control landed in the workspace");
});
