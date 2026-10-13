// lib/routes/branches.mjs — Candidate Branch & Diff Landing Inspector HTTP routes.
//
// Lets the room operator inspect candidate task branches created by coding agents,
// view diffs and merge readiness, and land (merge) or keep them separate.

import {
  listCandidateBranches,
  inspectBranchDiff,
  landCandidateBranch,
  keepBranchSeparate,
} from "../branch-landing.mjs";

export function createBranchRoutes({ repoRoot, getRepoRoot, json, readJsonBody, answerOnce }) {
  const resolveRoot = () => (getRepoRoot ? getRepoRoot() : repoRoot);

  return {
    "GET /api/branches/candidates": async (_req, res, url) => {
      const root = resolveRoot();
      const baseBranch = url?.searchParams?.get("baseBranch") || "main";
      const result = listCandidateBranches(root, { baseBranch });
      return json(res, result.ok ? 200 : 400, result);
    },

    "GET /api/branches/diff": async (_req, res, url) => {
      const root = resolveRoot();
      const branch = url?.searchParams?.get("branch") || "";
      const baseBranch = url?.searchParams?.get("baseBranch") || "main";
      if (!branch) {
        return json(res, 400, { ok: false, refused: "bad-request", why: "branch query parameter is required" });
      }
      const result = inspectBranchDiff(root, branch, { baseBranch });
      return json(res, result.ok ? 200 : 400, result);
    },

    "POST /api/branches/merge": async (req, res) => {
      const parsed = await readJsonBody(req, res);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON with branch" });
      }
      return answerOnce(res, async () => {
        const root = resolveRoot();
        const branch = String(parsed.branch || "").trim();
        const baseBranch = String(parsed.baseBranch || "main").trim();
        if (!branch) {
          return json(res, 400, { ok: false, refused: "bad-request", why: "branch field is required" });
        }
        const result = landCandidateBranch(root, branch, { baseBranch });
        return json(res, result.ok ? 200 : 409, result);
      });
    },

    "POST /api/branches/keep-separate": async (req, res) => {
      const parsed = await readJsonBody(req, res);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON with branch" });
      }
      return answerOnce(res, async () => {
        const root = resolveRoot();
        const branch = String(parsed.branch || "").trim();
        const note = String(parsed.note || "").trim();
        if (!branch) {
          return json(res, 400, { ok: false, refused: "bad-request", why: "branch field is required" });
        }
        const result = keepBranchSeparate(root, branch, { note });
        return json(res, result.ok ? 200 : 400, result);
      });
    },
  };
}
