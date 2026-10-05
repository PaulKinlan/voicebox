// public/room-folder-ops.js — FileSystemDirectoryHandle operations for room folders and OPFS.
//
// Pure ES module with zero Node or external dependencies so it runs identically in the browser
// against a real FileSystemDirectoryHandle (picked folder or OPFS scratchpad) and in Node unit
// tests against an in-memory handle fixture.

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_GREP_BYTES = 512 * 1024;
const IGNORED_GREP_DIRS = new Set([
  ".git",
  ".audit",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
  "vendor",
]);

/**
 * Validate a relative path string without touching any handle.
 * Rejects empty paths, absolute paths (`/`), `..` or `.` segments, or backslashes
 * with `{ ok: false, refused: "outside-root", why }`.
 */
export function validateSubpath(relPath) {
  if (typeof relPath !== "string") {
    return {
      ok: false,
      refused: "outside-root",
      why: "path must be a non-empty relative string",
    };
  }
  const trimmed = relPath.trim();
  if (!trimmed) {
    return {
      ok: false,
      refused: "outside-root",
      why: "path is empty — name a file inside the folder",
    };
  }
  if (trimmed.startsWith("/")) {
    return {
      ok: false,
      refused: "outside-root",
      why: `'${relPath}' is an absolute path — paths must be relative to the folder root`,
    };
  }
  if (trimmed.includes("\\")) {
    return {
      ok: false,
      refused: "outside-root",
      why: `'${relPath}' contains backslashes — use forward slashes inside the folder`,
    };
  }
  const rawSegments = trimmed.split("/");
  if (rawSegments.some((seg) => seg === ".." || seg === ".")) {
    return {
      ok: false,
      refused: "outside-root",
      why: `'${relPath}' escapes or traverses the folder root`,
    };
  }
  const segments = rawSegments.filter(Boolean);
  if (segments.length === 0) {
    return {
      ok: false,
      refused: "outside-root",
      why: `'${relPath}' names no file inside the folder`,
    };
  }
  return {
    ok: true,
    segments,
    leafName: segments[segments.length - 1],
    normalizedPath: segments.join("/"),
  };
}

/**
 * Validate `relPath` and walk subdirectory segments on `rootHandle`.
 * Returns `{ ok: true, dirHandle, leafName, normalizedPath }` or
 * `{ ok: false, refused: "outside-root", why }`.
 */
export async function resolveSubpath(rootHandle, relPath, { createDirs = false } = {}) {
  const checked = validateSubpath(relPath);
  if (!checked.ok) return checked;
  if (!rootHandle || typeof rootHandle.getDirectoryHandle !== "function") {
    return {
      ok: false,
      refused: "no-root",
      why: "no folder handle is open",
    };
  }
  let dirHandle = rootHandle;
  const { segments, leafName, normalizedPath } = checked;
  for (let i = 0; i < segments.length - 1; i++) {
    dirHandle = await dirHandle.getDirectoryHandle(segments[i], { create: createDirs });
  }
  return {
    ok: true,
    dirHandle,
    leafName,
    normalizedPath,
  };
}

/**
 * Read UTF-8 text and byte length of `relPath` from `rootHandle`.
 */
export async function readHandleFile(rootHandle, relPath, { maxBytes = DEFAULT_MAX_READ_BYTES } = {}) {
  const sub = await resolveSubpath(rootHandle, relPath, { createDirs: false });
  if (sub.refused) return sub;
  const fileHandle = await sub.dirHandle.getFileHandle(sub.leafName);
  const file = await fileHandle.getFile();
  const bytes = typeof file.size === "number" ? file.size : 0;
  const truncated = bytes > maxBytes;
  const text = await (truncated && typeof file.slice === "function" ? file.slice(0, maxBytes) : file).text();
  return {
    ok: true,
    file: sub.normalizedPath,
    text,
    content: text,
    bytes,
    truncated,
  };
}

/**
 * Write `content` to `relPath` inside `rootHandle` via `createWritable()`,
 * read back the observed file size, and return `{ ok: true, file, bytes, previousContent, existed }`.
 */
export async function writeHandleFile(rootHandle, relPath, content) {
  const sub = await resolveSubpath(rootHandle, relPath, { createDirs: true });
  if (sub.refused) return sub;

  let existed = false;
  let previousContent = null;
  try {
    const existingHandle = await sub.dirHandle.getFileHandle(sub.leafName, { create: false });
    const existingFile = await existingHandle.getFile();
    previousContent = await existingFile.text();
    existed = true;
  } catch {
    existed = false;
    previousContent = null;
  }

  const textContent = String(content ?? "");
  const fileHandle = await sub.dirHandle.getFileHandle(sub.leafName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(textContent);
  await writable.close();

  const expected = new TextEncoder().encode(textContent).length;
  const observedFile = await fileHandle.getFile();
  const observed = typeof observedFile.size === "number" ? observedFile.size : expected;
  if (observed !== expected) {
    throw new Error(
      `the file did not read back what was written (wrote ${expected} bytes, read ${observed} back) — it is not saved`,
    );
  }

  return {
    ok: true,
    file: sub.normalizedPath,
    bytes: observed,
    previousContent,
    existed,
  };
}

/**
 * Delete `relPath` inside `rootHandle`, reading its existing content first so undo can restore it.
 * Returns `{ ok: true, deleted: normalizedPath, file: normalizedPath, previousContent }` or a named refusal.
 */
export async function deleteHandleFile(rootHandle, relPath) {
  let sub;
  try {
    sub = await resolveSubpath(rootHandle, relPath, { createDirs: false });
  } catch {
    return {
      ok: false,
      refused: "not-found",
      why: `'${relPath}' was not found in this folder`,
    };
  }
  if (sub.refused) return sub;

  let previousContent;
  try {
    const fileHandle = await sub.dirHandle.getFileHandle(sub.leafName, { create: false });
    const file = await fileHandle.getFile();
    previousContent = await file.text();
  } catch {
    return {
      ok: false,
      refused: "not-found",
      why: `'${sub.normalizedPath}' was not found in this folder`,
    };
  }

  await sub.dirHandle.removeEntry(sub.leafName);
  return {
    ok: true,
    deleted: sub.normalizedPath,
    file: sub.normalizedPath,
    previousContent,
  };
}

/**
 * Edit `relPath` by replacing a unique occurrence of `oldText` with `newText`.
 * Refuses with `old-text-not-found` if absent or `ambiguous-match` if it occurs more than once.
 */
export async function editHandleFile(rootHandle, relPath, oldText, newText) {
  let sub;
  try {
    sub = await resolveSubpath(rootHandle, relPath, { createDirs: false });
  } catch {
    return {
      ok: false,
      refused: "not-found",
      why: `'${relPath}' was not found in this folder`,
    };
  }
  if (sub.refused) return sub;

  if (oldText == null || newText == null || String(oldText) === "") {
    return {
      ok: false,
      refused: "missing-argument",
      why: `edit on '${sub.normalizedPath}' requires non-empty oldText and newText`,
    };
  }

  let previousContent;
  try {
    const fileHandle = await sub.dirHandle.getFileHandle(sub.leafName, { create: false });
    const file = await fileHandle.getFile();
    previousContent = await file.text();
  } catch {
    return {
      ok: false,
      refused: "not-found",
      why: `'${sub.normalizedPath}' was not found in this folder`,
    };
  }

  const needle = String(oldText);
  const replacement = String(newText);
  const firstIdx = previousContent.indexOf(needle);
  if (firstIdx === -1) {
    return {
      ok: false,
      refused: "old-text-not-found",
      why: `could not find '${needle}' in '${sub.normalizedPath}'`,
    };
  }
  const lastIdx = previousContent.lastIndexOf(needle);
  if (lastIdx !== firstIdx) {
    return {
      ok: false,
      refused: "ambiguous-match",
      why: `'${needle}' occurs more than once in '${sub.normalizedPath}' — specify a unique text block`,
    };
  }

  const updated =
    previousContent.slice(0, firstIdx) +
    replacement +
    previousContent.slice(firstIdx + needle.length);

  const written = await writeHandleFile(rootHandle, sub.normalizedPath, updated);
  if (written.refused) return written;

  return {
    ok: true,
    file: sub.normalizedPath,
    bytes: written.bytes,
    previousContent,
  };
}

/**
 * Compute a unified diff (`--- a/<file>`, `+++ b/<file>`, `@@ ... @@`, `-`/`+`/` ` lines)
 * between two strings using prefix/suffix trimming and LCS.
 */
export function buildUnifiedDiff(filename, oldStr, newStr) {
  if (oldStr === newStr) return "";
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const lines = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  for (let idx = 0; idx < start; idx++) {
    lines.push(` ${oldLines[idx]}`);
  }

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);
  const m = midOld.length;
  const n = midNew.length;

  if (m * n <= 250_000) {
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && midOld[i] === midNew[j]) {
        lines.push(` ${midOld[i]}`);
        i++;
        j++;
      } else if (i < m && (j === n || dp[i + 1][j] >= dp[i][j + 1])) {
        lines.push(`-${midOld[i]}`);
        i++;
      } else {
        lines.push(`+${midNew[j]}`);
        j++;
      }
    }
  } else {
    for (let i = 0; i < m; i++) lines.push(`-${midOld[i]}`);
    for (let j = 0; j < n; j++) lines.push(`+${midNew[j]}`);
  }

  for (let idx = endOld; idx < oldLines.length; idx++) {
    lines.push(` ${oldLines[idx]}`);
  }

  return lines.join("\n");
}

/**
 * Compute a unified diff between the current content of `relPath` in `rootHandle` and `proposedContent`.
 * Returns `{ ok: true, file: normalizedPath, changed: boolean, diff: string, via: "page" }`.
 */
export async function diffHandleFile(rootHandle, relPath, proposedContent) {
  const checked = validateSubpath(relPath);
  if (!checked.ok) return checked;

  let current = "";
  try {
    const sub = await resolveSubpath(rootHandle, relPath, { createDirs: false });
    if (!sub.refused) {
      const fileHandle = await sub.dirHandle.getFileHandle(sub.leafName, { create: false });
      const file = await fileHandle.getFile();
      current = await file.text();
    }
  } catch {
    current = "";
  }

  const proposed = typeof proposedContent === "string" ? proposedContent : String(proposedContent ?? "");
  const changed = current !== proposed;
  const diff = buildUnifiedDiff(checked.normalizedPath, current, proposed);
  return {
    ok: true,
    file: checked.normalizedPath,
    changed,
    diff,
    via: "page",
  };
}

/**
 * Recursively walk `rootHandle.entries()` (skipping `.git` and `node_modules`),
 * search text files for `query` (case-insensitive substring), and return
 * `{ ok: true, query, count: matches.length, matches: [{ file, line, text }], truncated }`
 * matching `presentInspectionInReader("grep", ...)` in `public/fused.js`.
 */
export async function grepHandleFolder(rootHandle, query, { maxMatches = 100 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) {
    return {
      ok: false,
      refused: "missing-argument",
      why: "grep requires a non-empty search query",
    };
  }
  if (!rootHandle || typeof rootHandle.entries !== "function") {
    return {
      ok: false,
      refused: "no-root",
      why: "no folder handle is open",
    };
  }

  const matches = [];
  let truncated = false;
  const lowerQuery = q.toLowerCase();

  async function scanDir(dirHandle, relDir = "") {
    if (matches.length >= maxMatches) {
      truncated = true;
      return;
    }
    const items = [];
    for await (const [name, handle] of dirHandle.entries()) {
      items.push([name, handle]);
    }
    items.sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, handle] of items) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      if (name.startsWith(".") || IGNORED_GREP_DIRS.has(name)) continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (handle.kind === "directory") {
        await scanDir(handle, relPath);
      } else if (handle.kind === "file") {
        try {
          const file = await handle.getFile();
          if (typeof file.size === "number" && file.size > DEFAULT_MAX_GREP_BYTES) continue;
          const text = await file.text();
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i];
            if (lineText.toLowerCase().includes(lowerQuery)) {
              if (matches.length >= maxMatches) {
                truncated = true;
                break;
              }
              matches.push({
                file: relPath,
                line: i + 1,
                text: lineText.slice(0, 300),
              });
            }
          }
        } catch {
          // Unreadable or binary entry; skip and continue scanning.
        }
      }
    }
  }

  await scanDir(rootHandle, "");
  return {
    ok: true,
    query: q,
    count: matches.length,
    matches,
    truncated,
  };
}

/**
 * Bounded undo stack for room-folder mutations (`write`, `edit`, `delete`).
 * Records `{ kind: "write" | "edit" | "delete", path, existed, previousContent }`
 * and exposes `push(entry)`, `canUndo()`, and `async undo(rootHandle)`.
 */
export function createRoomUndoStack(maxDepth = 20) {
  const stack = [];

  return {
    push(entry) {
      if (!entry || typeof entry !== "object") return;
      const kind = entry.kind ?? entry.verb ?? "write";
      const path = entry.path ?? entry.file ?? entry.name ?? "";
      if (!path) return;
      const existed = entry.existed ?? entry.existedBefore ?? kind !== "write";
      const previousContent = entry.previousContent ?? null;
      stack.push({
        kind,
        path,
        existed: Boolean(existed),
        previousContent,
      });
      if (stack.length > maxDepth) {
        stack.shift();
      }
    },

    canUndo() {
      return stack.length > 0;
    },

    clear() {
      stack.length = 0;
    },

    get length() {
      return stack.length;
    },

    async undo(rootHandle) {
      if (stack.length === 0) {
        return {
          ok: false,
          refused: "nothing-to-undo",
          why: "no mutating file action (write, edit, delete) has been recorded in this folder yet",
        };
      }
      const entry = stack.pop();
      try {
        if (entry.kind === "delete" || entry.existed) {
          const res = await writeHandleFile(rootHandle, entry.path, entry.previousContent ?? "");
          if (res.refused) return res;
        } else {
          const res = await deleteHandleFile(rootHandle, entry.path);
          if (res.refused && res.refused !== "not-found") return res;
        }
      } catch (err) {
        return {
          ok: false,
          refused: "undo-failed",
          why: `could not revert ${entry.kind} on '${entry.path}': ${err?.message ?? err}`,
        };
      }
      return {
        ok: true,
        action: `reverted ${entry.kind} on ${entry.path}`,
        file: entry.path,
        revertedVerb: entry.kind,
        remainingUndos: stack.length,
      };
    },
  };
}

/**
 * Parse natural spoken/typed turns for local room-folder execution:
 *   - `delete <file>` / `remove file <file>` -> `{ verb: "delete", name }`
 *   - `edit <file> replace "<old>" with "<new>"` -> `{ verb: "edit", name, oldText, newText }`
 *   - `diff <file> with <content>` -> `{ verb: "diff", name, content }`
 *   - `grep <query>` / `search for <query>` / `find <query> in files` -> `{ verb: "grep", query }`
 *   - `undo` / `undo last action` / `revert last change` -> `{ verb: "undo" }`
 * Returns `null` if the transcript does not match a local room-folder operation.
 */
export function parseRoomFolderTurn(transcript) {
  if (typeof transcript !== "string") return null;
  const raw = transcript.trim();
  if (!raw) return null;

  if (
    /^(?:undo|revert)(?:\s+(?:the\s+)?(?:last|that|previous)(?:\s+(?:action|change|edit|write|delete|file|turn))?)?$/i.test(
      raw,
    )
  ) {
    return { verb: "undo" };
  }

  const delMatch = raw.match(/^(?:delete|remove|rm)\s+(?:the\s+)?(?:file\s+)?["']?([\w./-]+)["']?$/i);
  if (delMatch) {
    return { verb: "delete", name: delMatch[1] };
  }

  const editQuoted = raw.match(
    /^(?:edit|modify|update)\s+(?:the\s+)?(?:file\s+)?["']?([\w./-]+)["']?\s+replace\s+["'](.*?)["']\s+with\s+["'](.*?)["']$/is,
  );
  if (editQuoted) {
    return {
      verb: "edit",
      name: editQuoted[1],
      oldText: editQuoted[2],
      newText: editQuoted[3],
    };
  }

  const editUnquoted = raw.match(
    /^(?:edit|modify|update)\s+(?:the\s+)?(?:file\s+)?["']?([\w./-]+)["']?\s+replace\s+(\S+)\s+with\s+(.+)$/is,
  );
  if (editUnquoted) {
    return {
      verb: "edit",
      name: editUnquoted[1],
      oldText: editUnquoted[2].replace(/^["']|["']$/g, ""),
      newText: editUnquoted[3].replace(/^["']|["']$/g, ""),
    };
  }

  const diffMatch = raw.match(/^diff\s+(?:the\s+)?(?:file\s+)?["']?([\w./-]+)["']?\s+(?:with|containing)\s*(.*)/is);
  if (diffMatch) {
    const [, name, rest] = diffMatch;
    const content = rest.replace(/^(?:with|containing)\s+/i, "").replace(/^["']|["']$/g, "");
    return { verb: "diff", name, content };
  }

  // Do not match web search commands (`search the web for ...` / `web search ...`) as grep.
  if (/^(?:web\s+search|search\s+the\s+web|web_search)\b/i.test(raw)) {
    return null;
  }

  const findInFiles = raw.match(
    /^(?:find|search(?:\s+for)?|grep(?:\s+for)?)\s+["']?(.+?)["']?\s+in\s+(?:the\s+)?files$/i,
  );
  if (findInFiles && findInFiles[1].trim()) {
    return {
      verb: "grep",
      query: findInFiles[1].trim().replace(/^["']|["']$/g, ""),
    };
  }

  const grepMatch = raw.match(/^(?:grep(?:\s+for)?|search\s+for)\s+["']?(.+?)["']?$/i);
  if (grepMatch && grepMatch[1].trim()) {
    return {
      verb: "grep",
      query: grepMatch[1].trim().replace(/^["']|["']$/g, ""),
    };
  }

  // Project/workspace switching commands belong to the host workspace route, never local file read/grep.
  if (
    /\b(?:change|switch)\s+(?:over\s+)?to\b/i.test(raw) ||
    /\b(?:open|switch|change)\s+(?:the\s+)?(?:workspace|project|sandbox|voice\s*box)\b/i.test(raw) ||
    /\s+(?:project|workspace|codebase)(?:[,?.!\s]*please[,?.!\s]*)?$/i.test(raw)
  ) {
    return null;
  }

  const readNatural = raw.match(
    /^(?:(?:please|can\s+you|could\s+you)\s+)?(?:read|open|show|display|view)(?:\s+up)?(?:\s+me)?(?:\s+the)?(?:\s+(?:content|contents)\s+of)?(?:\s+the)?(?:\s+file)?(?:\s+(?:called|named))?\s+["']?([\w./-]+)["']?(?:\s+(?:in|on)\s+(?:the\s+)?(?:ui|user\s+interface|reader|viewer|screen|page))?$/i,
  );
  if (
    readNatural &&
    !/^(?:files|all\s+files|folder|directory|project|workspace|voicebox|self|codebase|repo|repository|tools|all\s+tools|capabilities|commands|history|settings|harnesses|environments|extensions|agents|status|diff|log|commits)$/i.test(
      readNatural[1],
    )
  ) {
    return { verb: "read", name: readNatural[1] };
  }

  return null;
}
