import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateTransportBundle,
  validateTransportPath,
} from "../core/env-transport.ts";
import {
  exportWorkspaceBundle,
  importWorkspaceBundle,
  sha256Utf8,
} from "../lib/env-transport.mjs";

function withScratchDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vb-env-transport-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("core/env-transport — validateTransportPath", () => {
  it("accepts clean relative file paths", () => {
    assert.deepEqual(validateTransportPath("README.md"), {
      ok: true,
      normalized: "README.md",
    });
    assert.deepEqual(validateTransportPath("src/components/card.ts"), {
      ok: true,
      normalized: "src/components/card.ts",
    });
  });

  it("refuses empty strings, null bytes, backslashes, dot segments, and .git paths", () => {
    for (const bad of ["", "   ", "bad\0file.txt", "a\\b.txt", ".", "./a.txt", "a/./b.txt", "a//b.txt", ".git", ".git/config", "sub/.git/HEAD"]) {
      const res = validateTransportPath(bad);
      assert.equal(res.ok, false, `expected '${bad}' to be refused`);
      assert.equal(res.refused, "invalid-transport-path");
    }
  });

  it("refuses leading slashes, Windows drive letters, and '..' traversal segments", () => {
    for (const escape of ["/etc/passwd", "C:/Windows/win.ini", "d:secret.txt", "..", "../evil.sh", "nested/../../evil.sh"]) {
      const res = validateTransportPath(escape);
      assert.equal(res.ok, false, `expected '${escape}' to be refused`);
      assert.equal(res.refused, "outside-root");
    }
  });
});

describe("core/env-transport — validateTransportBundle", () => {
  const sampleContent = "export const answer = 42;\n";
  const sampleEntry = {
    path: "src/answer.ts",
    bytes: Buffer.byteLength(sampleContent, "utf8"),
    sha256: sha256Utf8(sampleContent),
    content: sampleContent,
  };

  it("accepts a well-formed transport bundle", () => {
    const res = validateTransportBundle({
      schema: "voicebox-transport/1",
      sourceEnvironment: "scratchpad-opfs",
      sourceKind: "opfs",
      exportedAt: "2026-09-29T23:00:00.000Z",
      files: [sampleEntry],
    });
    assert.equal(res.ok, true);
    assert.equal(res.bundle.files.length, 1);
    assert.equal(res.bundle.files[0].path, "src/answer.ts");
  });

  it("refuses unknown schema, bad sourceKind, duplicate paths, traversal paths, and oversize bundles", () => {
    const badSchema = validateTransportBundle({
      schema: "voicebox-transport/999",
      sourceEnvironment: "env-a",
      sourceKind: "machine",
      exportedAt: "2026-09-29T23:00:00.000Z",
      files: [sampleEntry],
    });
    assert.equal(badSchema.ok, false);
    assert.equal(badSchema.refused, "unsupported-schema");

    const badKind = validateTransportBundle({
      schema: "voicebox-transport/1",
      sourceEnvironment: "env-a",
      sourceKind: "cloud-bucket",
      exportedAt: "2026-09-29T23:00:00.000Z",
      files: [sampleEntry],
    });
    assert.equal(badKind.ok, false);
    assert.equal(badKind.refused, "invalid-source-kind");

    const traversal = validateTransportBundle({
      schema: "voicebox-transport/1",
      sourceEnvironment: "env-a",
      sourceKind: "machine",
      exportedAt: "2026-09-29T23:00:00.000Z",
      files: [{ ...sampleEntry, path: "../evil.txt" }],
    });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.refused, "outside-root");

    const duplicate = validateTransportBundle({
      schema: "voicebox-transport/1",
      sourceEnvironment: "env-a",
      sourceKind: "machine",
      exportedAt: "2026-09-29T23:00:00.000Z",
      files: [sampleEntry, { ...sampleEntry }],
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.refused, "duplicate-path");

    const badDigest = validateTransportBundle({
      schema: "voicebox-transport/1",
      sourceEnvironment: "env-a",
      sourceKind: "machine",
      exportedAt: "2026-09-29T23:00:00.000Z",
      files: [{ ...sampleEntry, sha256: "not-a-valid-sha256" }],
    });
    assert.equal(badDigest.ok, false);
    assert.equal(badDigest.refused, "invalid-sha256");

    const tooManyFiles = validateTransportBundle(
      {
        schema: "voicebox-transport/1",
        sourceEnvironment: "env-a",
        sourceKind: "machine",
        exportedAt: "2026-09-29T23:00:00.000Z",
        files: [
          { ...sampleEntry, path: "a.ts" },
          { ...sampleEntry, path: "b.ts" },
        ],
      },
      { maxFiles: 1 },
    );
    assert.equal(tooManyFiles.ok, false);
    assert.equal(tooManyFiles.refused, "too-many-files");

    const tooLarge = validateTransportBundle(
      {
        schema: "voicebox-transport/1",
        sourceEnvironment: "env-a",
        sourceKind: "machine",
        exportedAt: "2026-09-29T23:00:00.000Z",
        files: [sampleEntry],
      },
      { maxTotalBytes: 10 },
    );
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.refused, "bundle-too-large");
  });
});

describe("lib/env-transport — exportWorkspaceBundle & importWorkspaceBundle", () => {
  it("exports nested files from Environment A and imports them into Environment B with exact byte and SHA-256 fidelity", () => {
    withScratchDir((root) => {
      const dirA = path.join(root, "env-a");
      const dirB = path.join(root, "env-b");
      const outside = path.join(root, "outside.txt");
      mkdirSync(path.join(dirA, "src", "nested"), { recursive: true });
      mkdirSync(path.join(dirA, "node_modules", "pkg"), { recursive: true });
      mkdirSync(path.join(dirA, ".git"), { recursive: true });
      mkdirSync(dirB, { recursive: true });

      writeFileSync(outside, "secret outside root", "utf8");
      writeFileSync(path.join(dirA, "README.md"), "# Project Alpha\nUTF-8 check: λ → ✓\n", "utf8");
      writeFileSync(path.join(dirA, "src", "nested", "util.js"), "export const sum = (a, b) => a + b;\n", "utf8");
      writeFileSync(path.join(dirA, ".env"), "SECRET=hidden\n", "utf8");
      writeFileSync(path.join(dirA, ".git", "config"), "[core]\n", "utf8");
      writeFileSync(path.join(dirA, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf8");
      symlinkSync(outside, path.join(dirA, "escaped-link.txt"));

      const exported = exportWorkspaceBundle(dirA, {
        sourceEnvironment: "env-a-host",
        sourceKind: "machine",
      });
      assert.equal(exported.ok, true);
      assert.equal(exported.bundle.sourceEnvironment, "env-a-host");
      assert.equal(exported.bundle.sourceKind, "machine");
      assert.deepEqual(
        exported.bundle.files.map((f) => f.path),
        ["README.md", "src/nested/util.js"],
      );

      const imported = importWorkspaceBundle(dirB, exported.bundle);
      assert.equal(imported.ok, true);
      assert.deepEqual(imported.imported, ["README.md", "src/nested/util.js"]);
      assert.equal(imported.sourceEnvironment, "env-a-host");

      assert.equal(
        readFileSync(path.join(dirB, "README.md"), "utf8"),
        "# Project Alpha\nUTF-8 check: λ → ✓\n",
      );
      assert.equal(
        readFileSync(path.join(dirB, "src", "nested", "util.js"), "utf8"),
        "export const sum = (a, b) => a + b;\n",
      );
      assert.equal(existsSync(path.join(dirB, ".env")), false);
      assert.equal(existsSync(path.join(dirB, "escaped-link.txt")), false);
    });
  });

  it("refuses tampered content with digest-mismatch and performs zero partial writes", () => {
    withScratchDir((root) => {
      const dirA = path.join(root, "env-a");
      const dirB = path.join(root, "env-b");
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });

      writeFileSync(path.join(dirA, "first.txt"), "clean first file\n", "utf8");
      writeFileSync(path.join(dirA, "second.txt"), "clean second file\n", "utf8");

      const exported = exportWorkspaceBundle(dirA, {
        sourceEnvironment: "env-a",
        sourceKind: "sandbox",
      });
      assert.equal(exported.ok, true);

      // Tamper with the second file's content so that even though the first file is valid,
      // atomic preflight must refuse the whole bundle before writing first.txt.
      const tamperedBundle = structuredClone(exported.bundle);
      tamperedBundle.files[1].content = "tampered payload!\n";

      const res = importWorkspaceBundle(dirB, tamperedBundle);
      assert.equal(res.ok, false);
      assert.equal(res.refused, "digest-mismatch");
      assert.deepEqual(readdirSync(dirB), []);
    });
  });

  it("refuses declared byte size mismatch with size-mismatch and performs zero partial writes", () => {
    withScratchDir((root) => {
      const dirA = path.join(root, "env-a");
      const dirB = path.join(root, "env-b");
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });

      writeFileSync(path.join(dirA, "first.txt"), "clean first file\n", "utf8");
      writeFileSync(path.join(dirA, "second.txt"), "clean second file\n", "utf8");

      const exported = exportWorkspaceBundle(dirA);
      assert.equal(exported.ok, true);

      const badSizeBundle = structuredClone(exported.bundle);
      badSizeBundle.files[1].bytes += 5;

      const res = importWorkspaceBundle(dirB, badSizeBundle);
      assert.equal(res.ok, false);
      assert.equal(res.refused, "size-mismatch");
      assert.deepEqual(readdirSync(dirB), []);
    });
  });

  it("refuses importing into a symlinked target file or symlinked parent directory escaping dirB", () => {
    withScratchDir((root) => {
      const dirA = path.join(root, "env-a");
      const dirB = path.join(root, "env-b");
      const outsideDir = path.join(root, "outside-dir");
      const outsideFile = path.join(outsideDir, "victim.txt");
      mkdirSync(path.join(dirA, "sub"), { recursive: true });
      mkdirSync(dirB, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(outsideFile, "untouched victim\n", "utf8");
      writeFileSync(path.join(dirA, "first.txt"), "first file\n", "utf8");
      writeFileSync(path.join(dirA, "sub", "escape.txt"), "attempted overwrite via symlink\n", "utf8");

      const exported = exportWorkspaceBundle(dirA);
      assert.equal(exported.ok, true);

      // Case 1: parent directory in dirB is a symlink pointing outside dirB
      symlinkSync(outsideDir, path.join(dirB, "sub"));

      const resParentSymlink = importWorkspaceBundle(dirB, exported.bundle);
      assert.equal(resParentSymlink.ok, false);
      assert.equal(resParentSymlink.refused, "symlink-refused");
      assert.equal( existsSync(path.join(dirB, "first.txt")), false, "atomic preflight must not write first.txt" );
      assert.equal( existsSync(path.join(outsideDir, "escape.txt")), false );

      // Case 2: leaf target in dirB is a symlink pointing to outsideFile
      rmSync(path.join(dirB, "sub"), { recursive: true, force: true });
      mkdirSync(path.join(dirB, "sub"), { recursive: true });
      symlinkSync(outsideFile, path.join(dirB, "sub", "escape.txt"));

      const resLeafSymlink = importWorkspaceBundle(dirB, exported.bundle);
      assert.equal(resLeafSymlink.ok, false);
      assert.equal(resLeafSymlink.refused, "symlink-refused");
      assert.equal(existsSync(path.join(dirB, "first.txt")), false);
      assert.equal(readFileSync(outsideFile, "utf8"), "untouched victim\n");
    });
  });
});
