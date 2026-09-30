import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSubpath,
  readHandleFile,
  writeHandleFile,
  deleteHandleFile,
  editHandleFile,
  diffHandleFile,
  grepHandleFolder,
  createRoomUndoStack,
  parseRoomFolderTurn,
} from "../public/room-folder-ops.js";

function createMockFileHandle(name, initialText = "") {
  let content = String(initialText);
  return {
    kind: "file",
    name,
    async getFile() {
      const encoded = new TextEncoder().encode(content);
      return {
        name,
        size: encoded.byteLength,
        async text() {
          return content;
        },
        slice(start, end) {
          const sliced = encoded.slice(start, end);
          return {
            async text() {
              return new TextDecoder().decode(sliced);
            },
          };
        },
      };
    },
    async createWritable() {
      let staged = "";
      return {
        async write(chunk) {
          staged += String(chunk);
        },
        async close() {
          content = staged;
        },
      };
    },
  };
}

function createMockDirectoryHandle(name = "root") {
  const children = new Map();
  return {
    kind: "directory",
    name,
    async getDirectoryHandle(dirName, { create = false } = {}) {
      const existing = children.get(dirName);
      if (existing) {
        if (existing.kind !== "directory") {
          throw new Error(`TypeMismatchError: '${dirName}' is not a directory`);
        }
        return existing;
      }
      if (!create) {
        const err = new Error(`NotFoundError: directory '${dirName}' not found`);
        err.name = "NotFoundError";
        throw err;
      }
      const created = createMockDirectoryHandle(dirName);
      children.set(dirName, created);
      return created;
    },
    async getFileHandle(fileName, { create = false } = {}) {
      const existing = children.get(fileName);
      if (existing) {
        if (existing.kind !== "file") {
          throw new Error(`TypeMismatchError: '${fileName}' is not a file`);
        }
        return existing;
      }
      if (!create) {
        const err = new Error(`NotFoundError: file '${fileName}' not found`);
        err.name = "NotFoundError";
        throw err;
      }
      const created = createMockFileHandle(fileName, "");
      children.set(fileName, created);
      return created;
    },
    async removeEntry(entryName) {
      if (!children.has(entryName)) {
        const err = new Error(`NotFoundError: '${entryName}' not found`);
        err.name = "NotFoundError";
        throw err;
      }
      children.delete(entryName);
    },
    async *entries() {
      for (const [k, v] of children.entries()) {
        yield [k, v];
      }
    },
  };
}

describe("public/room-folder-ops.js", () => {
  it("refuses path traversal, absolute paths, empty paths, and backslashes with outside-root", async () => {
    const root = createMockDirectoryHandle("project");

    for (const bad of ["", "   ", "/", "/etc/passwd", "../secret.txt", "src/../../secret.txt", "a\\b.txt", "."]) {
      const sub = await resolveSubpath(root, bad, { createDirs: true });
      assert.equal(sub.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
      assert.equal(sub.refused, "outside-root");
      assert.ok(sub.why);
    }

    const writeTraversal = await writeHandleFile(root, "../secret.txt", "nope");
    assert.equal(writeTraversal.ok, false);
    assert.equal(writeTraversal.refused, "outside-root");

    const editTraversal = await editHandleFile(root, "../secret.txt", "a", "b");
    assert.equal(editTraversal.ok, false);
    assert.equal(editTraversal.refused, "outside-root");

    const deleteTraversal = await deleteHandleFile(root, "../secret.txt");
    assert.equal(deleteTraversal.ok, false);
    assert.equal(deleteTraversal.refused, "outside-root");

    const diffTraversal = await diffHandleFile(root, "../secret.txt", "x");
    assert.equal(diffTraversal.ok, false);
    assert.equal(diffTraversal.refused, "outside-root");
  });

  it("writes and reads files including nested subdirectories (src/app.js)", async () => {
    const root = createMockDirectoryHandle("project");

    const w1 = await writeHandleFile(root, "src/app.js", "console.log('v1');\n");
    assert.equal(w1.ok, true);
    assert.equal(w1.file, "src/app.js");
    assert.equal(w1.bytes, 19);
    assert.equal(w1.existed, false);
    assert.equal(w1.previousContent, null);

    const r1 = await readHandleFile(root, "src/app.js");
    assert.equal(r1.ok, true);
    assert.equal(r1.text, "console.log('v1');\n");
    assert.equal(r1.bytes, 19);

    const w2 = await writeHandleFile(root, "src/app.js", "console.log('version 2');\n");
    assert.equal(w2.ok, true);
    assert.equal(w2.existed, true);
    assert.equal(w2.previousContent, "console.log('v1');\n");
    assert.equal(w2.bytes, 26);
  });

  it("edits a file in place and refuses missing or ambiguous oldText", async () => {
    const root = createMockDirectoryHandle("project");
    await writeHandleFile(root, "notes.md", "alpha\nbeta\ngamma\n");

    const missing = await editHandleFile(root, "notes.md", "delta", "omega");
    assert.equal(missing.ok, false);
    assert.equal(missing.refused, "old-text-not-found");

    const edited = await editHandleFile(root, "notes.md", "beta", "BETA_UPDATED");
    assert.equal(edited.ok, true);
    assert.equal(edited.file, "notes.md");
    assert.equal(edited.previousContent, "alpha\nbeta\ngamma\n");
    assert.equal(edited.bytes, "alpha\nBETA_UPDATED\ngamma\n".length);

    const readBack = await readHandleFile(root, "notes.md");
    assert.equal(readBack.text, "alpha\nBETA_UPDATED\ngamma\n");

    await writeHandleFile(root, "dup.txt", "repeat\nrepeat\n");
    const ambiguous = await editHandleFile(root, "dup.txt", "repeat", "once");
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.refused, "ambiguous-match");
  });

  it("computes a clean unified diff via diffHandleFile", async () => {
    const root = createMockDirectoryHandle("project");
    await writeHandleFile(root, "src/index.js", "line 1\nline 2\nline 3");

    const unchanged = await diffHandleFile(root, "src/index.js", "line 1\nline 2\nline 3");
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.file, "src/index.js");
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.diff, "");

    const changed = await diffHandleFile(root, "src/index.js", "line 1\nline two\nline 3");
    assert.equal(changed.ok, true);
    assert.equal(changed.file, "src/index.js");
    assert.equal(changed.changed, true);
    assert.match(changed.diff, /^--- a\/src\/index\.js/m);
    assert.match(changed.diff, /^\+\+\+ b\/src\/index\.js/m);
    assert.match(changed.diff, /^@@ -1,3 \+1,3 @@/m);
    assert.match(changed.diff, /^-line 2$/m);
    assert.match(changed.diff, /^\+line two$/m);
  });

  it("greps recursively across files while skipping .git and node_modules", async () => {
    const root = createMockDirectoryHandle("project");
    await writeHandleFile(root, "README.md", "# Project\nThis has a NEEDLE on line two.\n");
    await writeHandleFile(root, "src/app.js", "const x = 1;\n// needle in lowercase\n");
    await writeHandleFile(root, "node_modules/pkg/index.js", "NEEDLE should be ignored\n");
    await writeHandleFile(root, ".git/config", "NEEDLE in git should be ignored\n");

    const res = await grepHandleFolder(root, "needle");
    assert.equal(res.ok, true);
    assert.equal(res.query, "needle");
    assert.equal(res.count, 2);
    assert.deepEqual(res.matches, [
      { file: "README.md", line: 2, text: "This has a NEEDLE on line two." },
      { file: "src/app.js", line: 2, text: "// needle in lowercase" },
    ]);
  });

  it("deletes files and returns previousContent for undo", async () => {
    const root = createMockDirectoryHandle("project");
    await writeHandleFile(root, "temp.txt", "ephemeral content");

    const del = await deleteHandleFile(root, "temp.txt");
    assert.equal(del.ok, true);
    assert.equal(del.deleted, "temp.txt");
    assert.equal(del.previousContent, "ephemeral content");

    const secondDel = await deleteHandleFile(root, "temp.txt");
    assert.equal(secondDel.ok, false);
    assert.equal(secondDel.refused, "not-found");
  });

  it("undoes write, edit, and delete operations via createRoomUndoStack", async () => {
    const root = createMockDirectoryHandle("project");
    const undoStack = createRoomUndoStack(10);

    assert.equal(undoStack.canUndo(), false);
    const emptyUndo = await undoStack.undo(root);
    assert.equal(emptyUndo.ok, false);
    assert.equal(emptyUndo.refused, "nothing-to-undo");

    // 1. Write new file
    const w = await writeHandleFile(root, "src/app.js", "v1");
    undoStack.push({
      kind: "write",
      path: "src/app.js",
      existed: w.existed,
      previousContent: w.previousContent,
    });
    assert.equal(undoStack.canUndo(), true);

    // 2. Edit the file
    const e = await editHandleFile(root, "src/app.js", "v1", "v2");
    undoStack.push({
      kind: "edit",
      path: "src/app.js",
      existed: true,
      previousContent: e.previousContent,
    });

    // 3. Delete the file
    const d = await deleteHandleFile(root, "src/app.js");
    undoStack.push({
      kind: "delete",
      path: "src/app.js",
      existed: true,
      previousContent: d.previousContent,
    });

    // Undo delete -> file restored to "v2"
    const u1 = await undoStack.undo(root);
    assert.deepEqual(
      { ok: u1.ok, action: u1.action, file: u1.file },
      { ok: true, action: "reverted delete on src/app.js", file: "src/app.js" },
    );
    assert.equal((await readHandleFile(root, "src/app.js")).text, "v2");

    // Undo edit -> file restored to "v1"
    const u2 = await undoStack.undo(root);
    assert.deepEqual(
      { ok: u2.ok, action: u2.action, file: u2.file },
      { ok: true, action: "reverted edit on src/app.js", file: "src/app.js" },
    );
    assert.equal((await readHandleFile(root, "src/app.js")).text, "v1");

    // Undo initial write -> file removed
    const u3 = await undoStack.undo(root);
    assert.deepEqual(
      { ok: u3.ok, action: u3.action, file: u3.file },
      { ok: true, action: "reverted write on src/app.js", file: "src/app.js" },
    );
    assert.equal(undoStack.canUndo(), false);
    const afterRemove = await deleteHandleFile(root, "src/app.js");
    assert.equal(afterRemove.refused, "not-found");
  });

  it("parses delete, edit, diff, grep, and undo turns via parseRoomFolderTurn", () => {
    assert.deepEqual(parseRoomFolderTurn("delete notes.md"), {
      verb: "delete",
      name: "notes.md",
    });
    assert.deepEqual(parseRoomFolderTurn("remove file src/app.js"), {
      verb: "delete",
      name: "src/app.js",
    });
    assert.deepEqual(parseRoomFolderTurn('edit src/app.js replace "oldVal" with "newVal"'), {
      verb: "edit",
      name: "src/app.js",
      oldText: "oldVal",
      newText: "newVal",
    });
    assert.deepEqual(parseRoomFolderTurn("diff notes.md with updated line"), {
      verb: "diff",
      name: "notes.md",
      content: "updated line",
    });
    assert.deepEqual(parseRoomFolderTurn("grep TODO"), {
      verb: "grep",
      query: "TODO",
    });
    assert.deepEqual(parseRoomFolderTurn("search for launch_mini_app"), {
      verb: "grep",
      query: "launch_mini_app",
    });
    assert.deepEqual(parseRoomFolderTurn("find voicebox in files"), {
      verb: "grep",
      query: "voicebox",
    });
    assert.deepEqual(parseRoomFolderTurn("undo"), { verb: "undo" });
    assert.deepEqual(parseRoomFolderTurn("undo last action"), { verb: "undo" });
    assert.deepEqual(parseRoomFolderTurn("revert last change"), { verb: "undo" });

    assert.equal(parseRoomFolderTurn("search the web for weather"), null);
    assert.equal(parseRoomFolderTurn("create a file called a.txt with hi"), null);
  });
});
