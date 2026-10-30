/**
 * @summary Candidate branch inspection, diff viewing, and landing endpoints.
 */
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

export function createBranchRoutes({ repoRoot, getRepoRoot, json, readJsonBody, answerOnce, hasExtensionAuthority = () => false, decisionsFile = null }) {
  // hasExtensionAuthority defaults to fail-closed (voicebox-beads-gi60): landing a branch runs
  // `git checkout` + `git merge` on the host repository, which is the host's act, so a caller
  // wired without the authority seam must find the door closed, never open.
  const resolveRoot = () => (getRepoRoot ? getRepoRoot() : repoRoot);

  return {
    "GET /api/branches/candidates": async (_req, res, url) => {
      const root = resolveRoot();
      const baseBranch = url?.searchParams?.get("baseBranch") || "main";
      const result = listCandidateBranches(root, { baseBranch, decisionsFile });
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
      // LANDING IS A PROTECTED HOST ACT (voicebox-beads-gi60): it checks out the base branch and
      // merges a candidate into it, mutating the repository. Same wall as agent configuration and
      // task delegation: host token, authorized in-room session, or the room's own page origin.
      if (!hasExtensionAuthority(req)) {
        return json(res, 403, {
          ok: false,
          refused: "host-token-required",
          why: "landing a branch merges it into the repository — the host's act — and requires the host token (x-voicebox-host-token), an authorized in-room session, or a request from this room's own page origin",
        });
      }
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
        const result = keepBranchSeparate(root, branch, { note, decisionsFile });
        return json(res, result.ok ? 200 : 400, result);
      });
    },
  };
}
