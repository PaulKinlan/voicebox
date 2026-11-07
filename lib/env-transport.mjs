// lib/env-transport.mjs — host-side workspace bundle export and atomic verified import.
//
// Packages files from an environment's root directory into a self-verifying
// TransportBundle (with UTF-8 byte lengths and SHA-256 digests) and imports
// verified bundles into a target root directory with an all-or-nothing
// preflight check (refusing digest mismatches, size mismatches, path escapes,
// and symbolic links before writing a single byte).

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  TRANSPORT_SCHEMA,
  validateTransportBundle,
  validateTransportPath,
} from "../core/env-transport.ts";
import { authorizeResolvedPath, containedIn, dotfileSegmentInside } from "./path-auth.mjs";

/**
 * Compute the lowercase 64-hex SHA-256 digest of a UTF-8 string.
 */
export function sha256Utf8(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Recursively collect regular non-dot files under `currentDir`, skipping
 * `node_modules` and symbolic links.
 */
function walkRegularFiles(currentDir, realRoot, prefix = "", out = []) {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  // The REAL directory this call is listing (voicebox-beads-s4l7). The dotfile question below is asked as
  // `path.relative(realRoot, …)`, so the left-hand side has to be realized too: with an unresolved ancestor (a root
  // reached through a symlink) `path.relative` answers "../../alias/env/hello.txt" and the FIRST segment is "..",
  // which starts with a dot — so every file in the worktree was classified as a dotfile and the export came back
  // EMPTY while `ok: true`. Silent data loss is the worst shape a refusal can take, and this one was a dotfile
  // check answering a containment question.
  const realDir = realpathSync(currentDir);
  for (const item of entries) {
    // THE DOTFILE DENIAL COMES FROM ITS OWNER (voicebox-beads-3dma). This walk used to re-implement the question
    // as `item.name.startsWith(".")`, which is one of the near-copies lib/path-auth.mjs exists to retire — and a
    // copy can drift from the rule the file verbs apply. `dotfileSegmentInside` answers it segment-wise, so a
    // nested `.config` is refused for the same reason a leaf `.env` is.
    const dotSegment = dotfileSegmentInside(realRoot, path.join(realDir, item.name));
    if (dotSegment || item.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(currentDir, item.name);
    const relPath = prefix ? `${prefix}/${item.name}` : item.name;
    let st;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      continue;
    }
    if (st.isDirectory()) {
      walkRegularFiles(fullPath, realRoot, relPath, out);
    } else if (st.isFile()) {
      const realFile = realpathSync(fullPath);
      // The realized-path containment is the owned primitive (lib/path-auth.mjs) — a private
      // `startsWith(root + sep)` compare was this file's copy of it (voicebox-beads-q0a3).
      if (containedIn(realRoot, realFile)) {
        out.push({ fullPath, relPath });
      }
    }
  }
  return out;
}

/**
 * Export a workspace directory (or a requested subset of relative file paths)
 * as a verified `TransportBundle`.
 */
export function exportWorkspaceBundle(
  rootDir,
  { files = null, sourceEnvironment = "local", sourceKind = "machine" } = {},
) {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    return {
      ok: false,
      refused: "missing-root",
      why: "workspace rootDir must be a non-empty path",
    };
  }

  let rootStat;
  try {
    rootStat = lstatSync(rootDir);
  } catch {
    return {
      ok: false,
      refused: "missing-root",
      why: `workspace root '${rootDir}' does not exist`,
    };
  }

  if (rootStat.isSymbolicLink()) {
    return {
      ok: false,
      refused: "symlink-refused",
      why: `workspace root '${rootDir}' is a symbolic link`,
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      refused: "invalid-root",
      why: `workspace root '${rootDir}' is not a directory`,
    };
  }

  const realRoot = realpathSync(rootDir);
  let collected = [];

  if (files === null || files === undefined) {
    // Walk the REALIZED root, so every join this walk makes is already under `realRoot` and the dotfile question
    // cannot be answered with a relative ".." path (voicebox-beads-s4l7).
    collected = walkRegularFiles(realRoot, realRoot);
  } else {
    if (!Array.isArray(files)) {
      return {
        ok: false,
        refused: "invalid-files",
        why: "files option must be an array of relative paths or null",
      };
    }
    for (const rawRel of files) {
      const pathCheck = validateTransportPath(rawRel);
      if (!pathCheck.ok) {
        return pathCheck;
      }
      const segments = pathCheck.normalized.split("/");
      let cur = rootDir;
      let leafStat = null;
      for (let i = 0; i < segments.length; i++) {
        cur = path.join(cur, segments[i]);
        let st;
        try {
          st = lstatSync(cur);
        } catch {
          return {
            ok: false,
            refused: "missing-file",
            why: `requested file '${pathCheck.normalized}' does not exist in '${rootDir}'`,
          };
        }
        if (st.isSymbolicLink()) {
          return {
            ok: false,
            refused: "symlink-refused",
            why: `path '${pathCheck.normalized}' traverses or points to symbolic link '${segments.slice(0, i + 1).join("/")}'`,
          };
        }
        leafStat = st;
      }
      if (!leafStat || !leafStat.isFile()) {
        return {
          ok: false,
          refused: "not-a-file",
          why: `requested path '${pathCheck.normalized}' is not a regular file`,
        };
      }
      const realFile = realpathSync(cur);
      // The owned containment primitive again (lib/path-auth.mjs, voicebox-beads-q0a3) — the
      // realized leaf must land inside the realized root, by the same test every writer uses.
      if (!containedIn(realRoot, realFile)) {
        return {
          ok: false,
          refused: "outside-root",
          why: `requested path '${pathCheck.normalized}' resolves outside '${rootDir}'`,
        };
      }
      collected.push({ fullPath: cur, relPath: pathCheck.normalized });
    }
  }

  const bundleFiles = [];
  for (const { fullPath, relPath } of collected) {
    const content = readFileSync(fullPath, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const sha256 = sha256Utf8(content);
    bundleFiles.push({ path: relPath, bytes, sha256, content });
  }

  const rawBundle = {
    schema: TRANSPORT_SCHEMA,
    sourceEnvironment,
    sourceKind,
    exportedAt: new Date().toISOString(),
    files: bundleFiles,
  };

  return validateTransportBundle(rawBundle);
}

/**
 * Atomically validate and import a `TransportBundle` into `targetDir`.
 *
 * Performs a complete preflight check across every entry in the bundle before
 * writing any file: if any entry fails schema validation, SHA-256 digest
 * verification, UTF-8 byte length verification, path containment, or symlink
 * traversal, zero files are written and a named refusal is returned.
 */
export function importWorkspaceBundle(
  targetDir,
  rawBundle,
  // OVERWRITE IS OPT-IN (voicebox-beads-3dma). It used to default to true, so an import silently replaced whatever
  // was already at the target path — including a file the person had edited since the export. A writer that replaces
  // existing bytes has to be TOLD to; the route passes through an explicit `overwrite: true` or this stays false.
  { overwrite = false } = {},
) {
  const validated = validateTransportBundle(rawBundle);
  if (!validated.ok) {
    return validated;
  }
  const { bundle } = validated;

  if (typeof targetDir !== "string" || targetDir.trim() === "") {
    return {
      ok: false,
      refused: "missing-root",
      why: "targetDir must be a non-empty path",
    };
  }

  let targetStat;
  try {
    targetStat = lstatSync(targetDir);
  } catch {
    return {
      ok: false,
      refused: "missing-root",
      why: `target root '${targetDir}' does not exist`,
    };
  }

  if (targetStat.isSymbolicLink()) {
    return {
      ok: false,
      refused: "symlink-refused",
      why: `target root '${targetDir}' is a symbolic link`,
    };
  }
  if (!targetStat.isDirectory()) {
    return {
      ok: false,
      refused: "invalid-root",
      why: `target root '${targetDir}' is not a directory`,
    };
  }

  const realTargetRoot = realpathSync(targetDir);

  // Atomic preflight pass: verify digests, byte counts, and filesystem path safety
  // for EVERY file before mutating anything on disk.
  for (const entry of bundle.files) {
    const pathCheck = validateTransportPath(entry.path);
    if (!pathCheck.ok) {
      return pathCheck;
    }

    const actualSha256 = sha256Utf8(entry.content);
    if (actualSha256 !== entry.sha256) {
      return {
        ok: false,
        refused: "digest-mismatch",
        why: `file '${entry.path}' SHA-256 digest mismatch: declared ${entry.sha256}, computed ${actualSha256}`,
      };
    }

    const actualBytes = Buffer.byteLength(entry.content, "utf8");
    if (actualBytes !== entry.bytes) {
      return {
        ok: false,
        refused: "size-mismatch",
        why: `file '${entry.path}' byte length mismatch: declared ${entry.bytes}, actual ${actualBytes}`,
      };
    }

    const segments = entry.path.split("/");
    let cur = targetDir;
    // The realized form of the deepest part of this path that exists (voicebox-beads-s4l7): the writer is asked
    // about THAT, because a root reached through a symlinked ancestor is spelled differently from where it lands,
    // and asking the owner about the spelling made a legitimate import answer `outside-root`.
    let realCur = realTargetRoot;
    for (let i = 0; i < segments.length; i++) {
      cur = path.join(cur, segments[i]);
      let st = null;
      try {
        st = lstatSync(cur);
      } catch {
        st = null;
      }
      if (st === null) {
        // Neither this prefix nor any deeper segment exists on disk yet.
        break;
      }
      if (st.isSymbolicLink()) {
        return {
          ok: false,
          refused: "symlink-refused",
          why: `target path '${entry.path}' traverses or lands on symbolic link '${segments.slice(0, i + 1).join("/")}'`,
        };
      }
      realCur = realpathSync(cur);
      // The owned containment primitive (lib/path-auth.mjs, voicebox-beads-q0a3): realized prefix
      // containment WITH equality (the target root itself is legal), one computing site.
      if (!containedIn(realTargetRoot, realCur, { allowEqual: true })) {
        return {
          ok: false,
          refused: "outside-root",
          why: `target path '${entry.path}' resolves outside target root '${targetDir}'`,
        };
      }
      if (i < segments.length - 1 && !st.isDirectory()) {
        return {
          ok: false,
          refused: "not-a-directory",
          why: `parent segment '${segments.slice(0, i + 1).join("/")}' for '${entry.path}' exists and is not a directory`,
        };
      }
      if (i === segments.length - 1) {
        if (st.isDirectory()) {
          return {
            ok: false,
            refused: "target-is-directory",
            why: `target path '${entry.path}' is an existing directory`,
          };
        }
        if (!overwrite) {
          return {
            ok: false,
            refused: "file-exists",
            why: `target file '${entry.path}' already exists and overwrite is false`,
          };
        }
      }
    }
    // THE WRITER ASKS THE OWNER (voicebox-beads-3dma). `validateTransportPath` above answers "is this a legal
    // transport path" lexically — it is what refuses a dot segment before anything is touched, including a path
    // that does not exist yet. This answers the other question, on the deepest part of the path that DOES exist:
    // may this writer put bytes there, by real path, with the audit and the dotfile denial applied by
    // lib/path-auth.mjs rather than by a copy of it here. It runs after the symlink walk so the specific
    // `symlink-refused` answer keeps its own name instead of collapsing into `outside-root`.
    const authorized = authorizeResolvedPath(realTargetRoot, realCur);
    if (!authorized.ok) {
      return { ok: false, refused: authorized.refused, why: authorized.why };
    }
  }

  // Commit phase: all files passed preflight.
  const writtenPaths = [];
  let totalBytes = 0;

  for (const entry of bundle.files) {
    const destPath = path.join(targetDir, ...entry.path.split("/"));
    const parentDir = path.dirname(destPath);
    mkdirSync(parentDir, { recursive: true });
    const realParent = realpathSync(parentDir);
    if (!containedIn(realTargetRoot, realParent, { allowEqual: true })) {
      return {
        ok: false,
        refused: "outside-root",
        why: `parent directory for '${entry.path}' resolved outside target root '${targetDir}'`,
      };
    }
    writeFileSync(destPath, entry.content, "utf8");
    writtenPaths.push(entry.path);
    totalBytes += entry.bytes;
  }

  return {
    ok: true,
    imported: writtenPaths,
    bytes: totalBytes,
    sourceEnvironment: bundle.sourceEnvironment,
  };
}
