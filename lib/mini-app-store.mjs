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
    finalFileName = existing.fileName;
  } else if (fileName && String(fileName).trim()) {
    // RESOLVE, COMPARE, REFUSE — never rewrite (voicebox-beads-owit): this used to be
    // `path.basename(fileName)`, which silently turned '../escaped.html' into 'escaped.html'
    // and answered ok:true — a caller could not tell a rejected name from an accepted one,
    // and the file landed somewhere other than where it was asked to. A mini-app file name
    // names ONE file inside the root: a '..' segment refuses outside-root (the loop's own
    // vocabulary for a name that climbs), and anything more than a single segment refuses
    // the same way — a sub-path is a placement decision, not a name.
    const raw = String(fileName).trim();
    const segments = raw.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
    if (segments.some((s) => s === "..") || segments.length !== 1) {
      return {
        ok: false,
        refused: "outside-root",
        why: `'${raw}' is not a mini-app file name — a file name is a single name inside the workspace root, and it does not climb ('..' segments, sub-paths and absolute paths are all refused rather than rewritten)`,
      };
    }
    const cleanFile = segments[0];
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

  // 1. Always persist to Host Mini-App Shelf
  mkdirSync(shelfDir, { recursive: true });
  const shelfHtmlPath = path.join(shelfDir, path.basename(finalFileName));
  const shelfMetaPath = path.join(shelfDir, `${slug}.meta.json`);
  writeFileSync(shelfHtmlPath, html, "utf8");
  writeFileSync(
    shelfMetaPath,
    JSON.stringify(
      {
        appId: finalAppId,
        slug,
        title: finalTitle,
        fileName: path.basename(finalFileName),
        createdAt,
        updatedAt: nowIso,
        sizeBytes,
      },
      null,
      2,
    ),
    "utf8",
  );

  // 2. Also persist to Workspace Root when available
  let storagePath = shelfHtmlPath;
  let source = "host";
  if (resolvedRoot) {
    const workspaceFilePath = path.resolve(resolvedRoot, finalFileName);
    if (
      workspaceFilePath === resolvedRoot ||
      workspaceFilePath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      mkdirSync(path.dirname(workspaceFilePath), { recursive: true });
      writeFileSync(workspaceFilePath, html, "utf8");
      storagePath = workspaceFilePath;
      source = "workspace";
    }
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

  if (app.storagePath && existsSync(app.storagePath)) {
    rmSync(app.storagePath, { force: true });
  }

  if (app.source !== "sandbox") {
    if (shelfDir && isExistingDirectory(shelfDir)) {
      for (const candidate of [
        path.join(shelfDir, path.basename(app.fileName)),
        path.join(shelfDir, `${app.slug}.html`),
        path.join(shelfDir, `${app.slug}.meta.json`),
      ]) {
        if (existsSync(candidate)) {
          rmSync(candidate, { force: true });
        }
      }
    }

    if (rootPath && isExistingDirectory(rootPath)) {
      const resolvedRoot = path.resolve(rootPath);
      for (const candidate of [
        path.resolve(resolvedRoot, app.fileName),
        path.resolve(resolvedRoot, `${app.slug}.html`),
      ]) {
        if (
          candidate.startsWith(`${resolvedRoot}${path.sep}`) &&
          existsSync(candidate)
        ) {
          rmSync(candidate, { force: true });
        }
      }
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
