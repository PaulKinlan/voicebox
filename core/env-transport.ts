// core/env-transport.ts — audited cross-environment file transport vocabulary and pure validation.
//
// Environments in Voicebox are isolated by root kind and host boundary:
//   - opfs: origin-private browser storage (Scratchpad)
//   - browser-folder: a local directory handle picked in the browser
//   - machine: a host workspace folder on a server
//   - sandbox: an isolated fence home directory
//
// Moving files between two isolated environments never shares a live handle or
// bypasses containment. Instead, files cross the boundary as an explicit,
// self-verifying TransportBundle whose paths, byte counts, and SHA-256 digests
// are checked before any target environment writes a single byte.
//
// Pure module: zero imports outside core/, runs identically in browser workers and Node.

export type TransportSourceKind = "opfs" | "browser-folder" | "machine" | "sandbox";

export interface TransportFileEntry {
  path: string;
  bytes: number;
  sha256: string;
  content: string;
}

export interface TransportBundle {
  schema: "voicebox-transport/1";
  sourceEnvironment: string;
  sourceKind: TransportSourceKind;
  exportedAt: string;
  files: TransportFileEntry[];
}

export type PathValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; refused: "invalid-transport-path" | "outside-root"; why: string };

export type BundleValidationResult =
  | { ok: true; bundle: TransportBundle }
  | { ok: false; refused: string; why: string };

export const TRANSPORT_SCHEMA = "voicebox-transport/1" as const;
export const DEFAULT_MAX_TRANSPORT_FILES = 100;
export const DEFAULT_MAX_TRANSPORT_BYTES = 4 * 1024 * 1024; // 4 MiB

const VALID_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "opfs",
  "browser-folder",
  "machine",
  "sandbox",
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const utf8Encoder = new TextEncoder();

/**
 * Validate a relative path inside a transport bundle.
 *
 * Refuses empty strings, leading `/`, Windows drive letters, null bytes,
 * backslashes `\`, `.` or `..` path segments, empty segments (`//`),
 * or `.git/` internal paths.
 */
export function validateTransportPath(relPath: string): PathValidationResult {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    return {
      ok: false,
      refused: "invalid-transport-path",
      why: "transport path must be a non-empty string",
    };
  }
  if (relPath.includes("\0")) {
    return {
      ok: false,
      refused: "invalid-transport-path",
      why: "transport path must not contain null bytes",
    };
  }
  if (relPath.includes("\\")) {
    return {
      ok: false,
      refused: "invalid-transport-path",
      why: `transport path '${relPath}' contains '\\' — transport paths must use forward slashes`,
    };
  }
  if (relPath.startsWith("/") || WINDOWS_DRIVE_RE.test(relPath)) {
    return {
      ok: false,
      refused: "outside-root",
      why: `transport path '${relPath}' is absolute — only paths relative to the environment root may be transported`,
    };
  }

  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      return {
        ok: false,
        refused: "outside-root",
        why: `transport path '${relPath}' contains '..' which escapes the environment root`,
      };
    }
    if (seg === "" || seg === ".") {
      return {
        ok: false,
        refused: "invalid-transport-path",
        why: `transport path '${relPath}' contains an empty or '.' segment`,
      };
    }
    if (seg === ".git") {
      return {
        ok: false,
        refused: "invalid-transport-path",
        why: `transport path '${relPath}' targets protected .git internal paths`,
      };
    }
  }

  return { ok: true, normalized: segments.join("/") };
}

/**
 * Validate the structure, bounds, and path hygiene of a TransportBundle.
 */
export function validateTransportBundle(
  bundle: unknown,
  options?: { maxFiles?: number; maxTotalBytes?: number },
): BundleValidationResult {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return {
      ok: false,
      refused: "invalid-bundle",
      why: "transport bundle must be a JSON object",
    };
  }

  const raw = bundle as Record<string, unknown>;
  if (raw.schema !== TRANSPORT_SCHEMA) {
    return {
      ok: false,
      refused: "unsupported-schema",
      why: `bundle schema '${String(raw.schema)}' is not '${TRANSPORT_SCHEMA}'`,
    };
  }

  if (typeof raw.sourceEnvironment !== "string" || raw.sourceEnvironment.trim().length === 0) {
    return {
      ok: false,
      refused: "invalid-source-environment",
      why: "bundle must declare a non-empty sourceEnvironment string",
    };
  }

  if (typeof raw.sourceKind !== "string" || !VALID_SOURCE_KINDS.has(raw.sourceKind)) {
    return {
      ok: false,
      refused: "invalid-source-kind",
      why: `sourceKind '${String(raw.sourceKind)}' is not one of opfs, browser-folder, machine, sandbox`,
    };
  }

  if (raw.exportedAt !== undefined && (typeof raw.exportedAt !== "string" || raw.exportedAt.trim().length === 0)) {
    return {
      ok: false,
      refused: "invalid-exported-at",
      why: "exportedAt must be a non-empty ISO timestamp string",
    };
  }

  if (!Array.isArray(raw.files)) {
    return {
      ok: false,
      refused: "invalid-files",
      why: "bundle.files must be an array",
    };
  }

  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_TRANSPORT_FILES;
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TRANSPORT_BYTES;

  if (raw.files.length > maxFiles) {
    return {
      ok: false,
      refused: "too-many-files",
      why: `bundle contains ${raw.files.length} files, exceeding the maximum of ${maxFiles}`,
    };
  }

  const seenPaths = new Set<string>();
  const validatedFiles: TransportFileEntry[] = [];
  let totalBytes = 0;

  for (let i = 0; i < raw.files.length; i++) {
    const item = raw.files[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        refused: "invalid-file-entry",
        why: `files[${i}] must be an object`,
      };
    }

    const entry = item as Record<string, unknown>;
    const pathCheck = validateTransportPath(typeof entry.path === "string" ? entry.path : "");
    if (!pathCheck.ok) {
      return pathCheck;
    }

    if (seenPaths.has(pathCheck.normalized)) {
      return {
        ok: false,
        refused: "duplicate-path",
        why: `duplicate file path '${pathCheck.normalized}' in transport bundle`,
      };
    }
    seenPaths.add(pathCheck.normalized);

    if (typeof entry.content !== "string") {
      return {
        ok: false,
        refused: "invalid-file-content",
        why: `file '${pathCheck.normalized}' content must be a UTF-8 string`,
      };
    }

    if (typeof entry.bytes !== "number" || !Number.isInteger(entry.bytes) || entry.bytes < 0) {
      return {
        ok: false,
        refused: "invalid-file-bytes",
        why: `file '${pathCheck.normalized}' bytes must be a non-negative integer`,
      };
    }

    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      return {
        ok: false,
        refused: "invalid-sha256",
        why: `file '${pathCheck.normalized}' sha256 '${String(entry.sha256)}' is not a 64-character lowercase hex digest`,
      };
    }

    const actualUtf8Bytes = utf8Encoder.encode(entry.content).byteLength;
    totalBytes += Math.max(actualUtf8Bytes, entry.bytes);
    if (totalBytes > maxTotalBytes) {
      return {
        ok: false,
        refused: "bundle-too-large",
        why: `bundle total size (${totalBytes} bytes) exceeds maximum allowed (${maxTotalBytes} bytes)`,
      };
    }

    validatedFiles.push({
      path: pathCheck.normalized,
      bytes: entry.bytes,
      sha256: entry.sha256,
      content: entry.content,
    });
  }

  return {
    ok: true,
    bundle: {
      schema: TRANSPORT_SCHEMA,
      sourceEnvironment: raw.sourceEnvironment,
      sourceKind: raw.sourceKind as TransportSourceKind,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
      files: validatedFiles,
    },
  };
}
