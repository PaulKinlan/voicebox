/**
 * @summary Repository commit history and changelog query endpoint (GET /api/changelog).
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Sole owner of the GET changelog cache. Keep the host's old HEAD/ref-mtime key
// and worktree .git-file cache miss; this extraction does not change cache policy.
export function createChangelogRoutes({ repoRoot, json, execFileAsync }) {
  const changelogCache = { key: null, commits: null };
  return {
    "GET /api/changelog": async (_req, res) => {
      try {
        const headPath = path.join(repoRoot, ".git", "HEAD");
        let cacheKey = null;
        try {
          const headRaw = readFileSync(headPath, "utf8").trim();
          const headSt = statSync(headPath);
          let refMtime = 0;
          if (headRaw.startsWith("ref: ")) {
            try {
              refMtime = statSync(path.join(repoRoot, ".git", headRaw.slice(5))).mtimeMs;
            } catch {}
          }
          cacheKey = `${headRaw}:${headSt.mtimeMs}:${refMtime}:v2`;
        } catch {}
        if (cacheKey && changelogCache.key === cacheKey && changelogCache.commits) {
          return json(res, 200, { ok: true, repo: "https://github.com/PaulKinlan/voicebox", commits: changelogCache.commits });
        }
        const { stdout: raw } = await execFileAsync(
          "git",
          ["log", "-n", "30", "--pretty=format:%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%as%x1f%b%x1f", "--numstat"],
          {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        const commits = raw
          .split("\x1e")
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((chunk) => {
            const [sha = "", shortSha = "", subject = "", author = "", isoDate = "", date = "", rawBody = "", rawStat = ""] = chunk.split("\x1f");
            const bodyLines = rawBody
              .split(/\r?\n/)
              .map((line) => line.trimEnd())
              .filter((line) => !/^(Docs-checked|Co-authored-by|Signed-off-by):/i.test(line.trim()));
            const body = bodyLines.join("\n").trim();
            const statLines = rawStat
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            let filesChanged = 0;
            let insertions = 0;
            let deletions = 0;
            const files = [];
            for (const sLine of statLines) {
              const parts = sLine.split("\t");
              if (parts.length < 3) continue;
              const ins = Number.parseInt(parts[0], 10);
              const del = Number.parseInt(parts[1], 10);
              const filePath = parts.slice(2).join("\t").trim();
              filesChanged += 1;
              if (Number.isFinite(ins)) insertions += ins;
              if (Number.isFinite(del)) deletions += del;
              if (filePath && files.length < 12) files.push(filePath);
            }
            const prefixMatch = subject.match(/^([a-zA-Z]+)(?:\([^)]+\))?!?:\s*(.+)$/);
            const rawType = prefixMatch ? prefixMatch[1].toLowerCase() : "";
            const category =
              rawType === "feat" ? "feature"
              : rawType === "fix" ? "fix"
              : rawType === "perf" ? "performance"
              : rawType === "docs" ? "docs"
              : rawType === "refactor" ? "refactor"
              : rawType === "test" || rawType === "chore" ? "maintenance"
              : /\b(fix|bug|repair|resolve)\b/i.test(subject) ? "fix"
              : /\b(add|introduce|support|enable|implement|enrich|make)\b/i.test(subject) ? "feature"
              : "update";
            const firstParagraph = body.split(/\n\s*\n/)[0]?.trim() || "";
            const description = firstParagraph || (files.length > 0 ? `Updated ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` (+${files.length - 4} more)` : ""}` : subject);
            return {
              sha,
              shortSha,
              subject,
              author,
              date,
              isoDate,
              category,
              body,
              description,
              stats: { filesChanged, insertions, deletions },
              files,
              url: `https://github.com/PaulKinlan/voicebox/commit/${sha}`,
            };
          });
        if (cacheKey) {
          changelogCache.key = cacheKey;
          changelogCache.commits = commits;
        }
        return json(res, 200, { ok: true, repo: "https://github.com/PaulKinlan/voicebox", commits });
      } catch (e) {
        return json(res, 500, { ok: false, error: e?.message ?? String(e), repo: "https://github.com/PaulKinlan/voicebox", commits: [] });
      }
    },
  };
}
