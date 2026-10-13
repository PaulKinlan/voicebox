// lib/mini-app-store.mjs — Mini-App Persistence, In-Place Updates, Deletion & Cross-Sandbox Discovery.
//
// Owns persistent storage and discovery for Voicebox mini-apps across:
//   1. The Host Mini-App Shelf (`path.join(extensionsDir(), "mini-apps")`)
//   2. The Active Workspace Root (`rootPath`)
//   3. Sandbox Home Directories (`sandboxHomesDir()` and any extra sandbox roots)
//
// Uses `extensionsDir` and `sandboxHomesDir` from `./state-dirs.mjs` (single-owner compliant).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { extensionsDir, sandboxHomesDir } from "./state-dirs.mjs";
import { authorizeResolvedPath } from "./path-auth.mjs";

const SKIP_WORKSPACE_DIRS = new Set([
  "public",
  "node_modules",
  ".git",
  ".beads",
  "docs",
  "designs",
  "tests",
  "core",
  "lib",
  "scripts",
  "tools",
  "extensions",
]);

const SKIP_SANDBOX_DIRS = new Set([
  "node_modules",
  ".git",
  ".beads",
  ".cache",
  ".npm",
  ".local",
  ".config",
]);

function isExistingDirectory(candidate) {
  try {
    if (!candidate || typeof candidate !== "string" || !existsSync(candidate)) return false;
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isHtmlFileName(name) {
  return typeof name === "string" && /\.(?:html?|htm)$/i.test(name.trim());
}

/**
 * Normalize a mini-app title, filename, or appId into a deterministic lowercase slug.
 * Examples:
 *   "Pomodoro Timer" -> "pomodoro-timer"
 *   "pomodoro_timer.html" -> "pomodoro-timer"
 *   "app_pomodoro_timer" -> "pomodoro-timer"
 */
export function slugifyMiniApp(input) {
  if (!input || typeof input !== "string") return "mini-app";
  let cleaned = input.trim();
  if (!cleaned) return "mini-app";

  if (cleaned.startsWith("sandbox:")) {
    const parts = cleaned.split(":");
    cleaned = parts.slice(2).join(":") || cleaned;
  }

  cleaned = path.basename(cleaned);
  cleaned = cleaned.replace(/\.(?:html?|htm)$/i, "");
  cleaned = cleaned.replace(/^app[_-]+/i, "");
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "mini-app";
}

/**
 * Normalize an input identifier into a deterministic mini-app ID (`app_<slug>`),
 * preserving `sandbox:<sandboxName>:<relPath>` IDs verbatim.
 */
export function normalizeAppId(input) {
  if (typeof input === "string" && input.trim().startsWith("sandbox:")) {
    return input.trim();
  }
  return `app_${slugifyMiniApp(input)}`;
}

/**
 * Humanize a filename or slug into a readable title when no `<title>` tag is present.
 * Example: "flappy_bird.html" -> "Flappy Bird"
 */
export function humanizeMiniAppName(input) {
  const base = path
    .basename(String(input || "Mini App").trim())
    .replace(/\.(?:html?|htm)$/i, "")
    .replace(/^app[_-]+/i, "");
  const words = base
    .split(/[-_\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return "Mini App";
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Extract `<title>` (or fallback `<h1>`) from HTML markup, falling back to humanized filename.
 */
export function extractTitleFromHtml(html, fallbackName = "Mini App") {
  if (typeof html === "string") {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch && titleMatch[1].trim()) {
      return titleMatch[1].replace(/\s+/g, " ").trim();
    }
  }
  return humanizeMiniAppName(fallbackName);
}

function readMetaJson(metaPath) {
  try {
    if (!existsSync(metaPath)) return null;
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Does the shelf record at an app's slug PROVE that a workspace file is that app's own copy?
 * (voicebox-beads-dvu8)
 *
 * A workspace page and a shelf app can share a slug and a file name, so a NAME is not evidence of
 * ownership — and deleting or overwriting on the strength of a name is how an unrelated file was
 * destroyed. There are exactly two proofs, and nothing else:
 *   - the record names the file it was saved from (`workspacePath`, written by saveMiniApp), or
 *   - the shelf copy is byte-for-byte that file (records written before `workspacePath` existed).
 * The second is a snapshot comparison and is only meaningful when nothing is mid-write; callers that
 * race a write must not rely on it.
 */
function recordProvesWorkspaceFile(meta, shelfDir, fileName, workspaceFilePath) {
  if (!meta || !shelfDir || !fileName) return false;
  if (typeof meta.workspacePath === "string" && meta.workspacePath) {
    return meta.workspacePath === fileName;
  }
  const shelfCopy = path.join(shelfDir, path.basename(String(meta.fileName || fileName)));
  try {
    if (!existsSync(shelfCopy) || !workspaceFilePath || !existsSync(workspaceFilePath)) return false;
    return readFileSync(shelfCopy, "utf8") === readFileSync(workspaceFilePath, "utf8");
  } catch {
    return false;
  }
}

function scanHtmlFiles(baseDir, { maxDepth = 1, skipDirs = new Set() } = {}) {
  const results = [];

  function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && isHtmlFileName(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(baseDir, 0);
  return results;
}

/**
 * Discover `.html` / `.htm` mini-apps across:
 *   1. Workspace (`rootPath`, depth <= 1)
 *   2. Sandboxes (`sandboxRootDir/*` and `extraSandboxDirs`, depth <= 2)
 *   3. Host Shelf (`<hostDir>/mini-apps`)
 */
export function discoverMiniApps({
  rootPath = null,
  hostDir = extensionsDir(),
  sandboxRootDir = sandboxHomesDir(),
  extraSandboxDirs = [],
} = {}) {
  const effectiveHostDir = hostDir ?? extensionsDir();
  const shelfDir = effectiveHostDir ? path.join(effectiveHostDir, "mini-apps") : null;
  const miniApps = [];
  const seenWorkspaceOrHostSlugs = new Set();
  const seenWorkspaceOrHostFiles = new Set();

  // 1. Workspace mini-apps (rootPath)
  if (rootPath && isExistingDirectory(rootPath)) {
    const resolvedRoot = path.resolve(rootPath);
    const htmlPaths = scanHtmlFiles(resolvedRoot, {
      maxDepth: 1,
      skipDirs: SKIP_WORKSPACE_DIRS,
    });
    for (const fullPath of htmlPaths) {
      let html = "";
      let st;
      try {
        st = statSync(fullPath);
        html = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
      const relPath = path.relative(resolvedRoot, fullPath).split(path.sep).join("/");
      const slug = slugifyMiniApp(path.basename(fullPath));
      const shelfMeta = shelfDir
        ? readMetaJson(path.join(shelfDir, `${slug}.meta.json`))
        : null;
      const appId = shelfMeta?.appId || `app_${slug}`;
      const title = shelfMeta?.title || extractTitleFromHtml(html, relPath);

      miniApps.push({
        appId,
        slug,
        title,
        fileName: relPath,
        source: "workspace",
        storagePath: fullPath,
        sizeBytes: st.size,
        createdAt: shelfMeta?.createdAt || st.birthtime.toISOString(),
        updatedAt: shelfMeta?.updatedAt || st.mtime.toISOString(),
        html,
      });
      seenWorkspaceOrHostSlugs.add(slug);
      seenWorkspaceOrHostFiles.add(path.basename(fullPath).toLowerCase());
    }
  }

  // 2. Host Shelf mini-apps (<hostDir>/mini-apps)
  if (shelfDir && isExistingDirectory(shelfDir)) {
    const htmlPaths = scanHtmlFiles(shelfDir, { maxDepth: 0 });
    for (const fullPath of htmlPaths) {
      const baseName = path.basename(fullPath);
      const slug = slugifyMiniApp(baseName);
      if (seenWorkspaceOrHostSlugs.has(slug) || seenWorkspaceOrHostFiles.has(baseName.toLowerCase())) {
        continue;
      }
      let html = "";
      let st;
      try {
        st = statSync(fullPath);
        html = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
      const meta = readMetaJson(path.join(shelfDir, `${slug}.meta.json`));
      const appId = meta?.appId || `app_${slug}`;
      const title = meta?.title || extractTitleFromHtml(html, baseName);
      const fileName = meta?.fileName ? path.basename(meta.fileName) : baseName;

      miniApps.push({
        appId,
        slug,
        title,
        fileName,
        source: "host",
        storagePath: fullPath,
        sizeBytes: st.size,
        createdAt: meta?.createdAt || st.birthtime.toISOString(),
        updatedAt: meta?.updatedAt || st.mtime.toISOString(),
        html,
      });
      seenWorkspaceOrHostSlugs.add(slug);
      seenWorkspaceOrHostFiles.add(baseName.toLowerCase());
    }
  }

  // 3. Sandbox mini-apps (<sandboxRootDir>/<sandboxName> and extraSandboxDirs)
  const sandboxRoots = [];
  const effectiveSandboxRoot = sandboxRootDir ?? sandboxHomesDir();
  if (effectiveSandboxRoot && isExistingDirectory(effectiveSandboxRoot)) {
    try {
      const entries = readdirSync(effectiveSandboxRoot, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
        sandboxRoots.push({
          name: entry.name,
          dir: path.join(effectiveSandboxRoot, entry.name),
        });
      }
    } catch {
      // Ignore unreadable sandbox root
    }
  }

  if (Array.isArray(extraSandboxDirs)) {
    for (const item of extraSandboxDirs) {
      if (typeof item === "string" && isExistingDirectory(item)) {
        const resolved = path.resolve(item);
        sandboxRoots.push({ name: path.basename(resolved), dir: resolved });
      } else if (item && typeof item === "object") {
        const dirPath = item.path || item.dir;
        if (dirPath && isExistingDirectory(dirPath)) {
          const resolved = path.resolve(dirPath);
          sandboxRoots.push({
            name: String(item.name || item.id || path.basename(resolved)),
            dir: resolved,
          });
        }
      }
    }
  }

  const seenSandboxPaths = new Set();
  for (const sb of sandboxRoots) {
    const htmlPaths = scanHtmlFiles(sb.dir, {
      maxDepth: 2,
      skipDirs: SKIP_SANDBOX_DIRS,
    });
    for (const fullPath of htmlPaths) {
      const resolvedFull = path.resolve(fullPath);
      if (seenSandboxPaths.has(resolvedFull)) continue;
      seenSandboxPaths.add(resolvedFull);

      let html = "";
      let st;
      try {
        st = statSync(fullPath);
        html = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const relPath = path.relative(sb.dir, fullPath).split(path.sep).join("/");
      const slug = slugifyMiniApp(path.basename(fullPath));
      const appId = `sandbox:${sb.name}:${relPath}`;
      const title = extractTitleFromHtml(html, relPath);

      miniApps.push({
        appId,
        slug,
        title,
        fileName: relPath,
        sandbox: sb.name,
        source: "sandbox",
        storagePath: fullPath,
        sizeBytes: st.size,
        updatedAt: st.mtime.toISOString(),
        html,
      });
    }
  }

  return {
    ok: true,
    count: miniApps.length,
    miniApps,
  };
}

function matchMiniAppFromList(apps, target) {
  if (!target || typeof target !== "string" || !target.trim()) return null;
  const query = target.trim();
  const queryLower = query.toLowerCase();
  const querySlug = slugifyMiniApp(query);
  const queryNormId = normalizeAppId(query).toLowerCase();
  const queryBase = path.basename(query).toLowerCase();

  // 1. Exact appId match
  for (const app of apps) {
    if (String(app.appId).toLowerCase() === queryLower) return app;
  }
  // 2. Normalized appId match (for non-sandbox apps or matching slug)
  for (const app of apps) {
    if (String(app.appId).toLowerCase() === queryNormId) return app;
  }
  // 3. Exact fileName or basename match
  for (const app of apps) {
    if (
      String(app.fileName).toLowerCase() === queryLower ||
      path.basename(String(app.fileName)).toLowerCase() === queryBase
    ) {
      return app;
    }
  }
  // 4. Exact slug match
  for (const app of apps) {
    if (app.slug === querySlug) return app;
  }
  // 5. Case-insensitive title match
  for (const app of apps) {
    if (String(app.title).toLowerCase() === queryLower) return app;
  }
  return null;
}

/**
 * Save or update a mini-app in place (`created` vs `updated`) without duplicating IDs.
 * Writes to `<hostDir>/mini-apps/<fileName>` (plus `<slug>.meta.json`) and, when
 * `rootPath` is a valid directory, also writes `<rootPath>/<fileName>`.
 */
export function saveMiniApp({
  appId,
  title,
  html,
  fileName,
  rootPath = null,
  hostDir = extensionsDir(),
} = {}) {
  if (typeof html !== "string" || !html.trim()) {
    return {
      ok: false,
      refused: "missing-html",
      why: "Mini-app HTML content must be a non-empty string.",
    };
  }

  // A FILE NAME IS ONE NAME, checked at the DOOR and before any identity matching
  // (voicebox-beads-owit, review round 2). The first cut filtered empty segments and then
  // counted what survived, so '/app.html' and 'app.html/' were still silently rewritten;
  // and because matching ran first, '../escaped.html' answered ok:true whenever its basename
  // happened to match an existing app. Both ambiguity classes close the same way: any name
  // that contains a separator character, or is '.'/'..' or empty, is refused with the loop's
  // own vocabulary — resolve, compare, refuse; never rewrite. This is an input-shape rule,
  // not containment: whether a RESOLVED path is inside the root is the path-authorization
  // owner's question (q0a3's authorizeResolvedPath / core containment), not re-derived here.
  if (fileName != null && String(fileName) !== "") {
    const raw = String(fileName).trim();
    if (raw === "" || raw === "." || raw === ".." || /[\\/]/.test(raw)) {
      return {
        ok: false,
        refused: "outside-root",
        why: `'${String(fileName)}' is not a mini-app file name — a file name is ONE name inside the workspace root, given verbatim ('..' climbs, and separators — sub-paths, absolute paths, trailing or './' forms — are all placement decisions, refused rather than rewritten)`,
      };
    }
  }

  const effectiveHostDir = hostDir ?? extensionsDir();
  const shelfDir = path.join(effectiveHostDir, "mini-apps");
  const hasWorkspaceRoot = Boolean(rootPath && isExistingDirectory(rootPath));
  const resolvedRoot = hasWorkspaceRoot ? path.resolve(rootPath) : null;

  // Check existing workspace and host shelf mini-apps for an in-place match
  const discovered = discoverMiniApps({
    rootPath: resolvedRoot,
    hostDir: effectiveHostDir,
    sandboxRootDir: "",
    extraSandboxDirs: [],
  });
  const localApps = discovered.miniApps.filter((a) => a.source !== "sandbox");

  let existing = null;
  for (const candidateKey of [appId, fileName, title]) {
    if (candidateKey && String(candidateKey).trim()) {
      existing = matchMiniAppFromList(localApps, String(candidateKey));
      if (existing) break;
    }
  }

  const nowIso = new Date().toISOString();
  const created = !existing;
  const updated = Boolean(existing);

  const identitySeed =
    existing?.slug ||
    (fileName && String(fileName).trim()) ||
    (title && String(title).trim()) ||
    (appId && String(appId).trim()) ||
    extractTitleFromHtml(html, "mini-app");

  const slug = existing ? existing.slug : slugifyMiniApp(identitySeed);
  const finalAppId = existing
    ? existing.appId
    : appId && String(appId).trim().startsWith("sandbox:")
      ? String(appId).trim()
      : `app_${slug}`;

  let finalFileName;
  if (existing) {
    // An existing app's stored fileName comes from discovery (readdir-derived, dotfile-skipping),
    // so it is one name inside a root by construction — and the door check above has already
    // refused any caller-supplied fileName that was not.
    finalFileName = existing.fileName;
  } else if (fileName && String(fileName).trim()) {
    // Already validated at the door: one verbatim name, no separators, no climbing.
    const cleanFile = String(fileName).trim();
    finalFileName = isHtmlFileName(cleanFile) ? cleanFile : `${cleanFile}.html`;
  } else {
    finalFileName = `${slug}.html`;
  }

  const finalTitle =
    (title && String(title).trim()) ||
    existing?.title ||
    extractTitleFromHtml(html, finalFileName);

  const createdAt = existing?.createdAt || nowIso;
  const sizeBytes = Buffer.byteLength(html, "utf8");

  // 0. AUTHORIZE EVERY WRITE BEFORE ANY WRITE, so a refusal means NOTHING was written — not
  // even to the shelf (review P2, voicebox-beads-q0a3: the first cut wrote the shelf copy and
  // then refused the workspace one, so "refused" hid a side effect it had caused).
  // This is the ONE path-authorization owner (lib/path-auth.mjs), the same line every file
  // verb answers: realpath containment, the audit guard, the dotfile denial. The raw
  // `startsWith(root + sep)` compare this replaced was a private copy of containment with no
  // realpath pass and no dotfile denial — a `.hidden.html` save used to write what the listing
  // then refused to show, and a hand-rolled `path.resolve` join could climb wherever it liked.
  let workspaceFilePath = null;
  if (resolvedRoot) {
    workspaceFilePath = path.resolve(resolvedRoot, finalFileName);
    const verdict = authorizeResolvedPath(resolvedRoot, workspaceFilePath);
    if (!verdict.ok) {
      return {
        ok: false,
        refused: verdict.refused,
        why: `refusing to save mini-app '${finalFileName}' into the workspace root: ${verdict.why}`,
      };
    }
  }

  const shelfHtmlPath = path.join(shelfDir, path.basename(finalFileName));
  const shelfMetaPath = path.join(shelfDir, `${slug}.meta.json`);

  // THE COPY THIS SAVE REPLACES IS KEPT, NOT DESTROYED (voicebox-beads-dvu8). A save replaces the
  // shelf copy of whatever lives at this slug, and this base cannot yet tell an update of that app
  // from a DIFFERENT file that merely shares its name — deciding that is what the classification work
  // (voicebox-beads-rtsr) makes possible, and until then the overwrite cannot be refused without also
  // refusing legitimate updates of apps saved before this change. So the replaced copy and its record
  // are preserved one generation deep beside the shelf, under `<hostDir>/mini-app-backups/`: the next
  // save replaces them rather than accumulating, and deleteMiniApp removes them with the app. The
  // directory is deliberately NOT the shelf — discovery never looks there, so nothing is listed twice.
  if (existsSync(shelfHtmlPath)) {
    try {
      const previousHtml = readFileSync(shelfHtmlPath, "utf8");
      if (previousHtml !== html) {
        const backupHtmlPath = path.join(effectiveHostDir, "mini-app-backups", `previous-${slug}.html`);
        const backupMetaPath = path.join(effectiveHostDir, "mini-app-backups", `previous-${slug}.meta.json`);
        mkdirSync(path.dirname(backupHtmlPath), { recursive: true });
        // The same owner as every other write on this path (lib/path-auth.mjs): the backup is a write
        // like any other, and it is asked of the owner rather than assumed.
        if (authorizeResolvedPath(effectiveHostDir, backupHtmlPath).ok) {
          writeFileSync(backupHtmlPath, previousHtml, "utf8");
          const previousMeta = readMetaJson(shelfMetaPath);
          if (previousMeta) writeFileSync(backupMetaPath, JSON.stringify(previousMeta, null, 2), "utf8");
        }
      }
    } catch {
      // A backup that fails must not fail the save: the save is what the caller asked for, the copy is
      // a safety net, and losing the net is not a reason to refuse the work.
    }
  }

  // 1. The host shelf: created first (the owner realpaths its root), then authorized through the
  // SAME owner — ALWAYS, including when no usable workspace root exists (voicebox-beads-6gyv:
  // that conditional skip is exactly how a dotfile fileName landed on the shelf unauthorized
  // when the declared root had vanished — invisible to discovery, unaudited; the reviewer that
  // read for near-copies missed a conditional SKIP, which is why the CONDITION is what the
  // tests pin). The shelf join is basename'd, so containment holds by construction; what the
  // owner adds is the one vocabulary's dotfile and audit line. The shelf is not a second
  // containment site — it is a second ask of the same owner.
  mkdirSync(shelfDir, { recursive: true });
  const shelfVerdict = authorizeResolvedPath(shelfDir, shelfHtmlPath);
  if (!shelfVerdict.ok) {
    return {
      ok: false,
      refused: shelfVerdict.refused,
      why: `refusing to save mini-app '${finalFileName}' to the host shelf: ${shelfVerdict.why}`,
    };
  }
  writeFileSync(shelfHtmlPath, html, "utf8");
  writeFileSync(
    shelfMetaPath,
    JSON.stringify(
      {
        appId: finalAppId,
        slug,
        title: finalTitle,
        fileName: path.basename(finalFileName),
        // The record NAMES the workspace file it was saved from, so a later delete can tell that file
        // apart from a same-named page by reading rather than by comparing bytes (voicebox-beads-dvu8).
        // Omitted when there is no workspace copy, so it never points at a file that is not there.
        ...(workspaceFilePath ? { workspacePath: finalFileName } : {}),
        createdAt,
        updatedAt: nowIso,
        sizeBytes,
      },
      null,
      2,
    ),
    "utf8",
  );

  // 2. Also persist to Workspace Root when available (authorized above).
  let storagePath = shelfHtmlPath;
  let source = "host";
  if (workspaceFilePath) {
    mkdirSync(path.dirname(workspaceFilePath), { recursive: true });
    writeFileSync(workspaceFilePath, html, "utf8");
    storagePath = workspaceFilePath;
    source = "workspace";
  }

  return {
    ok: true,
    created,
    updated,
    miniApp: {
      appId: finalAppId,
      slug,
      title: finalTitle,
      fileName: finalFileName,
      html,
      sizeBytes,
      createdAt,
      updatedAt: nowIso,
      source,
      storagePath,
    },
  };
}

/**
 * Retrieve a mini-app's metadata and HTML content by `appId` (including `sandbox:<name>:<relPath>`),
 * `fileName`, `slug`, or case-insensitive `title`.
 */
export function getMiniApp(
  target,
  {
    rootPath = null,
    hostDir = extensionsDir(),
    sandboxRootDir = sandboxHomesDir(),
    extraSandboxDirs = [],
  } = {},
) {
  if (!target || typeof target !== "string" || !target.trim()) {
    return {
      ok: false,
      refused: "mini-app-not-found",
      why: "Specify a mini-app ID, file name, or title to open.",
    };
  }

  const discovered = discoverMiniApps({
    rootPath,
    hostDir,
    sandboxRootDir,
    extraSandboxDirs,
  });
  const matched = matchMiniAppFromList(discovered.miniApps, target);
  if (!matched) {
    return {
      ok: false,
      refused: "mini-app-not-found",
      why: `Mini-app '${target.trim()}' was not found in the active workspace, host shelf, or sandboxes.`,
    };
  }

  let html = matched.html;
  try {
    if (matched.storagePath && existsSync(matched.storagePath)) {
      html = readFileSync(matched.storagePath, "utf8");
    }
  } catch {
    // Keep cached HTML if read fails
  }

  return {
    ok: true,
    miniApp: {
      ...matched,
      html,
    },
  };
}

/**
 * Delete a mini-app from the workspace, host shelf, or sandbox.
 */
export function deleteMiniApp(
  target,
  {
    rootPath = null,
    hostDir = extensionsDir(),
    sandboxRootDir = sandboxHomesDir(),
    extraSandboxDirs = [],
  } = {},
) {
  const found = getMiniApp(target, {
    rootPath,
    hostDir,
    sandboxRootDir,
    extraSandboxDirs,
  });
  if (!found.ok) return found;

  const app = found.miniApp;
  const effectiveHostDir = hostDir ?? extensionsDir();
  const shelfDir = effectiveHostDir ? path.join(effectiveHostDir, "mini-apps") : null;

  // WHAT THIS APP OWNS, ASKED PER ARTIFACT (voicebox-beads-dvu8). A workspace page and a shelf app can
  // share a slug and a file name, and deleting on the strength of a name is how one destroyed the
  // other. The shelf record is the authority here: it owns the shelf copy and its own `.meta.json`
  // (matched by the appId inside it), and it owns a WORKSPACE file only when it proves that file is
  // its own copy — it names it (`workspacePath`) or the shelf copy is byte-for-byte that file (see
  // recordProvesWorkspaceFile). Every other candidate this used to guess at — `<slug>.html`, a second
  // basename — is gone: a name is not evidence of ownership.
  const shelfMetaPath = shelfDir ? path.join(shelfDir, `${app.slug}.meta.json`) : null;
  const shelfRecord = shelfMetaPath ? readMetaJson(shelfMetaPath) : null;
  const ownsRecord = Boolean(shelfRecord) && String(shelfRecord.appId || "") === String(app.appId);
  const ownsWorkspaceFile =
    app.source === "workspace" &&
    ownsRecord &&
    recordProvesWorkspaceFile(shelfRecord, shelfDir, app.fileName, app.storagePath);

  // 1. The file this entry IS — its own shelf copy, its sandbox file, or a workspace file it proved.
  //    A workspace file is its own when no record claims the slug at all (nothing else's identity is
  //    at stake) or when the record proves it; a file the record does NOT prove belongs to somebody
  //    else and is left on disk.
  const ownsItsOwnFile = app.source !== "workspace" || !shelfRecord || ownsWorkspaceFile;
  if (ownsItsOwnFile && app.storagePath && existsSync(app.storagePath)) {
    rmSync(app.storagePath, { force: true });
  }

  // 2. The shelf, and the preserved previous copy beside it: only for the app whose record this is.
  if (app.source !== "sandbox" && ownsRecord && shelfDir && isExistingDirectory(shelfDir)) {
    const shelfCopy = path.join(shelfDir, path.basename(String(shelfRecord.fileName || app.fileName)));
    if (existsSync(shelfCopy)) {
      rmSync(shelfCopy, { force: true });
    }
    if (existsSync(shelfMetaPath)) {
      rmSync(shelfMetaPath, { force: true });
    }
    for (const suffix of [`previous-${app.slug}.html`, `previous-${app.slug}.meta.json`]) {
      const backupPath = path.join(effectiveHostDir, "mini-app-backups", suffix);
      if (existsSync(backupPath)) {
        rmSync(backupPath, { force: true });
      }
    }
  }

  // 3. A workspace file the record proved is this app's copy is also removed — the app is going, and
  //    its own file goes with it. Nothing else in the workspace is touched, and no path is guessed at:
  //    the same owner as the save path (lib/path-auth.mjs, voicebox-beads-q0a3) is asked first, so a
  //    candidate that is not authorized is skipped, never deleted (the raw prefix compare this
  //    replaced had no realpath pass, so a symlink landing outside the root could have been followed).
  if (ownsWorkspaceFile && rootPath && isExistingDirectory(rootPath)) {
    const resolvedRoot = path.resolve(rootPath);
    const ownFile = path.resolve(resolvedRoot, app.fileName);
    if (authorizeResolvedPath(resolvedRoot, ownFile).ok && existsSync(ownFile)) {
      rmSync(ownFile, { force: true });
    }
  }

  return {
    ok: true,
    deleted: true,
    miniApp: {
      appId: app.appId,
      slug: app.slug,
      title: app.title,
      fileName: app.fileName,
      source: app.source,
      ...(app.sandbox ? { sandbox: app.sandbox } : {}),
    },
  };
}
