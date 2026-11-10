// tests/transport-import-authority.test.mjs — voicebox-beads-3dma (TM-WRITE-011 / TM-TRANSPORT-022).
//
//   node --test tests/transport-import-authority.test.mjs
//
// POST /api/transport/import writes files INTO THE DECLARED ROOT from a bundle the caller supplies, and the bundle
// names its own paths. Before this bead the route had no authority check at all, so any local process that could
// reach loopback could import — a write into the machine's own tree, not a page action. It also defaulted
// `overwrite` to true and refused only `.git` among dotfiles, so an entry ".bashrc" replaced the shell profile.
//
// These cases drive the REAL server, because the finding is about the route's door rather than the library's
// arithmetic: no token is refused with nothing written, the token opens it, a dotfile entry is refused by name,
// and an existing file is only replaced when the caller says `overwrite: true` in so many words.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

function bundleFor(files) {
  return {
    schema: "voicebox-transport/1",
    sourceEnvironment: "machine-elsewhere",
    sourceKind: "machine",
    exportedAt: new Date().toISOString(),
    files: files.map(({ path: rel, content }) => ({
      path: rel,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createSha(content),
    })),
  };
}

const { createHash } = await import("node:crypto");
function createSha(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function withServer(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-3dma-"));
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const server = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: workspace } });
  try {
    return await fn({ server, workspace, scratch });
  } finally {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const importBundle = (server, bundle, headers = {}) =>
  fetch(`${server.base}/api/transport/import`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bundle),
  });

test("POST /api/transport/import without the host token is refused and writes NOTHING (voicebox-beads-3dma)", async () => {
  await withServer(async ({ server, workspace }) => {
    const bundle = bundleFor([{ path: "planted.txt", content: "from an unauthenticated caller\n" }]);
    // An Origin header is a claim any local process can make, so it must not help either.
    for (const headers of [{}, { origin: server.base }, { "x-voicebox-session-token": "guessed" }]) {
      const res = await importBundle(server, bundle, headers);
      assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(Object.keys(headers))}`);
      const body = await res.json();
      assert.equal(body.refused, "host-token-required");
      assert.match(body.why, /host token/);
    }
    assert.deepEqual(fs.readdirSync(workspace), [], "a refused import still wrote into the root");
  });
});

test("with the host token the import works, and the positive control is a real write (voicebox-beads-3dma)", async () => {
  await withServer(async ({ server, workspace }) => {
    const bundle = bundleFor([
      { path: "docs/note.md", content: "imported\n" },
      { path: "src/nested/app.js", content: "export const ok = true;\n" },
    ]);
    const res = await importBundle(server, bundle, { "x-voicebox-host-token": server.hostToken });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.deepEqual(fs.readFileSync(path.join(workspace, "docs", "note.md"), "utf8"), "imported\n");
    assert.deepEqual(fs.readFileSync(path.join(workspace, "src", "nested", "app.js"), "utf8"), "export const ok = true;\n");
  });
});

test("a dotfile entry is refused by name on the route too, not only in the library (voicebox-beads-3dma)", async () => {
  await withServer(async ({ server, workspace }) => {
    for (const dot of [".bashrc", ".config/npm/rc", "nested/.env"]) {
      const res = await importBundle(server, bundleFor([{ path: dot, content: "pwned\n" }]), {
        "x-voicebox-host-token": server.hostToken,
      });
      assert.equal(res.status, 400, `${dot} was accepted`);
      const body = await res.json();
      assert.ok(
        body.refused === "dotfile-refused" || body.refused === "invalid-transport-path",
        `${dot} refused as ${body.refused}`,
      );
      assert.equal(fs.existsSync(path.join(workspace, dot)), false, `${dot} was written`);
    }
  });
});

test("replacing an existing file needs an explicit overwrite:true (voicebox-beads-3dma)", async () => {
  await withServer(async ({ server, workspace }) => {
    fs.writeFileSync(path.join(workspace, "README.md"), "the person's own edit\n", "utf8");
    const bundle = bundleFor([{ path: "README.md", content: "from the bundle\n" }]);

    // No `overwrite` field at all: the OLD route treated that as true and clobbered the file.
    const silent = await importBundle(server, bundle, { "x-voicebox-host-token": server.hostToken });
    assert.equal(silent.status, 400, "an omitted overwrite replaced the file");
    assert.equal((await silent.json()).refused, "file-exists");
    assert.equal(fs.readFileSync(path.join(workspace, "README.md"), "utf8"), "the person's own edit\n");

    // `overwrite: false` is the same refusal, spelled out.
    const explicitFalse = await importBundle(server, { ...bundle, overwrite: false }, {
      "x-voicebox-host-token": server.hostToken,
    });
    assert.equal(explicitFalse.status, 400);
    assert.equal((await explicitFalse.json()).refused, "file-exists");

    // The positive control: told to, it replaces.
    const allowed = await importBundle(server, { ...bundle, overwrite: true }, {
      "x-voicebox-host-token": server.hostToken,
    });
    assert.equal(allowed.status, 200, JSON.stringify(await allowed.clone().json()));
    assert.equal(fs.readFileSync(path.join(workspace, "README.md"), "utf8"), "from the bundle\n");
  });
});

// ── the READ direction of the same door (voicebox-beads-c84e) ─────────────────────────────────────────────────
//
// Export hands back the contents of every non-dot file under the declared machine root. Import has taken the host
// token since voicebox-beads-3dma; export did not, so one direction of the same door was open — and the mini-app
// relay is a caller that can reach it. The cases below are the mirror of the import set: no token is refused, an
// Origin and a guessed session token are refused too (neither distinguishes a local PROCESS from the person), and
// the token opens it and returns the file contents.
const exportBundle = (server, headers = {}, query = "") =>
  fetch(`${server.base}/api/transport/export${query}`, { headers });

test("GET /api/transport/export without the host token is refused, and the refusal leaks nothing about the root (voicebox-beads-c84e)", async () => {
  await withServer(async ({ server, workspace }) => {
    fs.writeFileSync(path.join(workspace, "secret-plans.txt"), "the machine's own business");
    for (const [what, headers] of [
      ["no headers at all", {}],
      ["an Origin claim", { origin: "http://127.0.0.1:1" }],
      ["a guessed in-room session token", { "x-voicebox-session-token": "guessed" }],
    ]) {
      const res = await exportBundle(server, headers);
      assert.equal(res.status, 403, `${what} must be refused`);
      const body = await res.json();
      assert.equal(body.refused, "host-token-required", `${what} must be refused by name`);
      assert.ok(!JSON.stringify(body).includes("secret-plans"), `${what}: the refusal must not name the root's files`);
      assert.ok(!JSON.stringify(body).includes(workspace), `${what}: the refusal must not disclose the root path`);
    }
  });
});

test("GET /api/transport/export with the host token returns the bundle, and only then (voicebox-beads-c84e)", async () => {
  await withServer(async ({ server, workspace }) => {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "hello from the machine root");
    const res = await exportBundle(server, { "x-voicebox-host-token": server.hostToken });
    assert.equal(res.status, 200, "the host token opens the read direction");
    const body = await res.json();
    assert.equal(body.ok, true);
    const entry = body.bundle.files.find((file) => file.path === "notes.txt");
    assert.ok(entry, `the bundle must carry notes.txt: ${JSON.stringify(body.bundle.files.map((f) => f.path))}`);
    assert.equal(entry.content, "hello from the machine root");
    // The negative control for the same call: the same request without the token cannot produce this body.
    const refused = await (await exportBundle(server)).json();
    assert.equal(refused.ok, false, "the same call without the token answers ok:false, never a bundle");
    assert.ok(!JSON.stringify(refused).includes("hello from the machine root"));
  });
});
