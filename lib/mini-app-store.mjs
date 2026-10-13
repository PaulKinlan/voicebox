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
 * Classify whether an HTML document is a Voicebox Mini-App or a generic HTML file.
 * Returns true if relativePath is inside a mini-apps/ or apps/ directory, or if
 * htmlContent contains an explicit mini-app signal (meta tag, SDK script, or globals).
 */
export function isMiniAppHtml(htmlContent, relativePath = "") {
  if (typeof relativePath === "string" && relativePath) {
    const normalised = relativePath.split(path.sep).join("/").toLowerCase();
    if (
      normalised.startsWith("mini-apps/") ||
      normalised.startsWith("apps/") ||
      normalised.includes("/mini-apps/") ||
      normalised.includes("/apps/")
    ) {
      return true;
    }
  }

  if (typeof htmlContent !== "string") return false;

  if (/<meta\s+[^>]*name=["']voicebox-(?:mini-)?app["']/i.test(htmlContent)) return true;
  if (/mini-app-sdk\.js/i.test(htmlContent)) return true;
  if (/navigator\.modelContext/i.test(htmlContent)) return true;
  if (/window\.voicebox/i.test(htmlContent)) return true;
  if (/data-voicebox-app/i.test(htmlContent)) return true;

  return false;
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
 * Does the shelf record at an app's slug NAME this workspace file as its own copy?
 * (voicebox-beads-dvu8, and the same question workspace discovery asks for `kind: "page"`)
 *
 * One question with two callers (voicebox-beads-rtsr + voicebox-beads-dvu8): discovery asks it to decide
 * whether a `.html` file IS the app the record describes — otherwise the file is a page, it takes no
 * shelf identity, and the shelf file stays free to be discovered as the app it actually is — and
 * deleteMiniApp asks it to decide whether a workspace file may be removed together with the app.
 *
 * `workspacePath` — written by saveMiniApp into the record — is the ONLY evidence accepted. The two
 * weaker signals this deliberately does not use are:
 *   - a matching `appId`: on this base a workspace file inherits the appId of the record at its slug, so
 *     the two always agree and the comparison proves nothing;
 *   - byte-for-byte equality with the shelf copy: an unrelated file that happens to be identical is
 *     indistinguishable from a copy, and a delete that trusted it would destroy a file the app never
 *     owned. A workspace page colliding with a shelf app is exactly that case.
 * So a record written before `workspacePath` existed cannot prove ownership of anything in the
 * workspace, and the workspace file is left alone — failing closed costs a leftover file; failing open
 * costs the file.
 */
function recordNamesWorkspaceFile(meta, fileName) {
  return Boolean(meta) && typeof meta.workspacePath === "string" && meta.workspacePath === fileName;
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
      const candidateMeta = shelfDir
        ? readMetaJson(path.join(shelfDir, `${slug}.meta.json`))
        : null;
      // A `.html` file in the workspace is a Page until a shelf record proves a person saved it as an
      // app (voicebox-beads-rtsr). Only a PROVEN file takes the shelf identity; an unproven one is
      // inert, so it also does not claim the slug — the real shelf app still gets discovered in §2.
      const provenApp = recordNamesWorkspaceFile(candidateMeta, relPath);
      const meta = provenApp ? candidateMeta : null;
      // A PAGE GETS ITS OWN ID SPACE (voicebox-beads-p7p1). `app_<slug>` is the shelf app's id, and
      // handing it to an unrelated page made two entries share one id — so the page, scanned first,
      // shadowed the app in every lookup by id, slug and file name. `page_<slug>` cannot collide with
      // an app id, a sandbox id, or the `file_<name>` id the room gives a reader-launched file.
      const appId = meta?.appId || (provenApp ? `app_${slug}` : `page_${slug}`);
      const title = meta?.title || extractTitleFromHtml(html, relPath);

      miniApps.push({
        appId,
        slug,
        title,
        fileName: relPath,
        source: "workspace",
        kind: provenApp ? "app" : "page",
        storagePath: fullPath,
        sizeBytes: st.size,
        createdAt: meta?.createdAt || st.birthtime.toISOString(),
        updatedAt: meta?.updatedAt || st.mtime.toISOString(),
        html,
      });
      if (!provenApp) continue;
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
        // On the shelf IS the app test: only saveMiniApp writes there (voicebox-beads-rtsr).
        kind: "app",
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
        // Sandbox files are user-authored inside a fence, so they stay apps rather than being
        // hidden with pages — the open product question on voicebox-beads-rtsr, defaulted as the
        // design pass (voicebox-arch-rtsr) directed.
        kind: "app",
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

  // THE FIRST STEP THAT MATCHES ANYTHING DECIDES, AND WITHIN THAT STEP AN APP OUTRANKS A PAGE
  // (voicebox-beads-p7p1). A bare workspace page is listed beside a shelf app that can share its
  // slug, its file name, or (before the id split) its id; "launch the mini-app called collision.html"
  // must mean the app. A page is still found whenever it is the only entry a step matches — by its
  // own title, or by its own `page_<slug>` id — so launching a page by name is unchanged.
  const steps = [
    // 1. Exact appId match
    (app) => String(app.appId).toLowerCase() === queryLower,
    // 2. Normalized appId match (for non-sandbox apps or matching slug)
    (app) => String(app.appId).toLowerCase() === queryNormId,
    // 3. Exact fileName or basename match
    (app) =>
      String(app.fileName).toLowerCase() === queryLower ||
      path.basename(String(app.fileName)).toLowerCase() === queryBase,
    // 4. Exact slug match
    (app) => app.slug === querySlug,
    // 5. Case-insensitive title match
    (app) => String(app.title).toLowerCase() === queryLower,
  ];
  for (const matches of steps) {
    const found = apps.filter(matches);
    if (found.length === 0) continue;
    return found.find((app) => app.kind !== "page") ?? found[0];
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

  // THE SAVE TARGET IS A FILE, SO FILE IDENTITY IS ASKED FIRST (voicebox-beads-p7p1). The caller just
  // wrote `<fileName>`, and a workspace entry with that name IS that file. matchMiniAppFromList
  // answers the other question — "the mini-app called X" — and prefers an app there, which must not
  // retarget a save onto a shelf app that merely shares the page's name.
  let existing = null;
  const wantedFile = fileName != null && String(fileName).trim() ? String(fileName).trim() : "";
  if (wantedFile) {
    const wantedLower = wantedFile.toLowerCase();
    const wantedBase = path.basename(wantedFile).toLowerCase();
    existing =
      localApps.find((a) => String(a.fileName).toLowerCase() === wantedLower) ??
      localApps.find(
        (a) => a.source === "workspace" && path.basename(String(a.fileName)).toLowerCase() === wantedBase,
      ) ??
      null;
  }
  if (!existing) {
    // An appId or a title names an APP, so the app-preferring order is the right one here — including
    // the `appId` the conversational verb supplies.
    for (const candidateKey of [appId, title]) {
      if (candidateKey && String(candidateKey).trim()) {
        existing = matchMiniAppFromList(localApps, String(candidateKey));
        if (existing) break;
      }
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

  // AN ENTRY KEEPS ITS IDENTITY, BUT A PAGE IS NOT AN APP (voicebox-beads-p7p1): promoting a page
  // must not carry its `page_<slug>` id into the app it becomes — a promoted page is the app it was
  // saved as, with the canonical id for its slug.
  const existingIsApp = Boolean(existing) && existing.kind !== "page";
  const slug = existing ? existing.slug : slugifyMiniApp(identitySeed);
  const finalAppId = existingIsApp
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

  // BEFORE ANY WRITE: THE SHELF SLOT THIS SAVE WOULD TAKE MAY BELONG TO A DIFFERENT APP. That is the
  // colliding-name case — an unrelated workspace page whose slug matches a shelf app (voicebox-beads-
  // dvu8/p7p1) — and writing would overwrite that app's copy and its record, which is data loss that
  // no later read could undo. Refuse by name; nothing is written. The check is the OWNER ENTRY rather
  // than the appId on purpose: a page promoted for a slug whose canonical id `app_<slug>` is exactly
  // the id the occupying app already has would slip past an id comparison.
  const shelfSlotOwner = localApps.find((a) => a !== existing && a.kind !== "page" && a.slug === slug);
  if (shelfSlotOwner) {
    return {
      ok: false,
      refused: "mini-app-name-taken",
      why: `'${finalFileName}' is already a mini-app on the shelf ('${shelfSlotOwner.title}', ${shelfSlotOwner.appId}) — saving this file as a mini-app would overwrite it. Rename this file, or delete that mini-app first.`,
    };
  }

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

  // A SAVE MAY NOT TAKE A NAME IT CANNOT PROVE IT OWNS (voicebox-beads-dvu8). A save that writes a
  // workspace copy replaces the shelf copy at this slug; if the record there names a DIFFERENT file (or
  // names none, which is every record written before `workspacePath` existed), this save cannot show
  // that it is updating that app rather than overwriting it with some other file that shares the name —
  // and on this base the two are byte-identical states, so guessing wrong destroys the app's content.
  // The refusal happens HERE, before any write of any kind: on a refusal nothing is written, not even a
  // directory, so "refused" cannot hide a side effect. Guessing right is worth less than not guessing.
  // The recoverable paths are named in the message: saving with no workspace root still updates such an
  // app's own shelf copy in place, and deleting the app lets this file be saved as an app of its own.
  if (workspaceFilePath) {
    const shelfRecord = readMetaJson(shelfMetaPath);
    if (shelfRecord && !recordNamesWorkspaceFile(shelfRecord, finalFileName)) {
      return {
        ok: false,
        refused: "mini-app-name-taken",
        why:
          `refusing to save mini-app '${finalFileName}': the shelf record for '${slug}' ` +
          (typeof shelfRecord.workspacePath === "string" && shelfRecord.workspacePath
            ? `names '${shelfRecord.workspacePath}' as its workspace file`
            : "names no workspace file (it was saved before that was recorded)") +
          `, so '${finalFileName}' may belong to something else — nothing was written. ` +
          `Delete the mini-app '${shelfRecord.title || slug}' first if this file is meant to replace it.`,
      };
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
      // A saved app IS an app — the same field discovery now emits (voicebox-beads-rtsr).
      kind: "app",
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
  // other. The shelf record is the authority here: it owns the shelf copy named inside it and its own
  // `.meta.json` (matched by the appId inside it), and it owns a WORKSPACE file only when it NAMES that
  // file as its own copy (`workspacePath` — see recordNamesWorkspaceFile; a shared appId and identical
  // bytes are both explicitly not proof). Every other candidate this used to guess at — `<slug>.html`, a
  // second basename — is gone: a name is not evidence of ownership.
  // A PAGE OWNS NO SHELF ARTIFACT, AND NO SHELF RECORD DESCRIBES IT (voicebox-beads-rtsr): its identity
  // is `page_<slug>`, so a record under that slug belongs to the app — reading it here is what put an
  // unrelated page's file behind the app's record in the first place.
  const isApp = app.kind !== "page";
  const shelfMetaPath = isApp && shelfDir ? path.join(shelfDir, `${app.slug}.meta.json`) : null;
  const shelfRecord = shelfMetaPath ? readMetaJson(shelfMetaPath) : null;
  const ownsRecord = Boolean(shelfRecord) && String(shelfRecord.appId || "") === String(app.appId);
  const ownsWorkspaceFile =
    isApp && app.source === "workspace" && ownsRecord && recordNamesWorkspaceFile(shelfRecord, app.fileName);

  // 1. The file this entry IS — its own shelf copy, its sandbox file, or a workspace file it NAMED.
  //    A page is the file it was discovered from, so it owns that file outright; an APP's workspace file
  //    is its own only when the record NAMES it. A file the record does not name is left on disk, which is
  //    what stops `deleteMiniApp("Collision App")` from taking an unrelated `collision.html` with it.
  const ownsItsOwnFile = !isApp || app.source !== "workspace" || ownsWorkspaceFile;
  if (ownsItsOwnFile && app.storagePath && existsSync(app.storagePath)) {
    rmSync(app.storagePath, { force: true });
  }

  // 2. The shelf: only for the app whose record this is — the copy the record names, and the record.
  if (isApp && app.source !== "sandbox" && ownsRecord && shelfDir && isExistingDirectory(shelfDir)) {
    const shelfCopy = path.join(shelfDir, path.basename(String(shelfRecord.fileName || app.fileName)));
    if (existsSync(shelfCopy)) {
      rmSync(shelfCopy, { force: true });
    }
    if (existsSync(shelfMetaPath)) {
      rmSync(shelfMetaPath, { force: true });
    }
  }

  // 3. A workspace file the record NAMED as this app's copy is also removed — the app is going, and its
  //    own file goes with it. Nothing else in the workspace is touched, and no path is guessed at: the
  //    same owner as the save path (lib/path-auth.mjs, voicebox-beads-q0a3) is asked first, so a
  //    candidate that is not authorized is skipped, never deleted (the raw prefix compare this replaced
  //    had no realpath pass, so a symlink landing outside the root could have been followed).
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
      // The deleted entry says what it was, the same way a discovered or saved one does
      // (voicebox-beads-rtsr) — a page can be deleted through this verb too.
      kind: app.kind,
      ...(app.sandbox ? { sandbox: app.sandbox } : {}),
    },
  };
}
