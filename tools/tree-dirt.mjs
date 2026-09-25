// tools/tree-dirt.mjs — "a process that writes must write outside anything another process
// measures" (voicebox-beads-bp8), as a mechanism rather than a sentence.
//
// WHY THIS EXISTS. Three instances landed on 2026-09-20, from three authors, all one shape:
// a writer left output where something else reads state, and the symptom was MISLEADING.
//
//   * the one-root test suite committed its own audit logs into the repository, so a change
//     looked like it carried files it never touched;
//   * the acceptance harness declared its scratch root on the shared server, so a person's
//     page showed a test's directory as if it were theirs;
//   * a Dolt backup was written into the served tree because the backup process's cwd WAS that
//     tree, and the harness's `git status --porcelain` check counts untracked directories — so
//     every landing attempted from that tree read as dirty for a reason no author caused.
//
// In each case the red check pointed at the wrong thing, and the next person paid: a reviewer
// chasing a file they did not write, a lane unable to land. A check whose failure describes the
// tooling rather than the change is the defect class §3.0 names — *the instrument has to be
// able to report the thing it is guarding.*
//
// Two mechanisms, one per half of the rule:
//
//   * `makeScratchDir` — writers get their scratch here, and a destination that resolves
//     inside the measured tree is REFUSED BY NAME (`writer-inside-measured-tree`) rather than
//     used. A guard that cannot do its job refuses rather than approximates (§3.0).
//   * `porcelainLines` + `dirtDelta` — a check that measures a tree snapshots it BEFORE the run
//     and reports what APPEARED, so the verdict says whether the dirt is this run's writing or
//     was there when the run began. Dirt that predates the run is named as pre-existing, not
//     blamed on a writer inside the run.
//
// The rule as the fleet agreed it: scratch dirs → temp, owned by the process that made them,
// removed by it; backups → outside every repository, re-runnable without landing inside one;
// test output → its own tree, never the served tree and never the audited root.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The refusal's own name, checked by callers and by the test. */
export const INSIDE_MEASURED_TREE = "writer-inside-measured-tree";

/**
 * The nearest existing ancestor, realpath'd — then the missing tail re-attached. Resolving alone
 * is an approximation (`/tmp` can itself be a symlink, and a path that does not exist yet has no
 * realpath), so this walks up until the filesystem can answer, which is the closest a guard gets
 * to comparing the path the write will actually land on.
 */
function resolveThroughExisting(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nothing exists all the way up; fall back once
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `candidate` outside `tree`? Containment is realpath-based, both directions, `tree` itself
 * included — the same shape as §3.2's root guard, for the same reason: a string prefix is a
 * rewrite that looks correct, and `/srv/tree-other` starts with `/srv/tree`.
 *
 * @returns {{ok: true, why: string} | {ok: false, refused: string, why: string}}
 */
export function outsideTree(candidate, tree) {
  const t = resolveThroughExisting(tree);
  const c = resolveThroughExisting(candidate);
  if (c === t || c.startsWith(t + path.sep)) {
    return {
      ok: false,
      refused: INSIDE_MEASURED_TREE,
      why: `'${candidate}' resolves inside the measured tree '${t}' — a writer's output must land outside anything another process measures`,
    };
  }
  return { ok: true, why: `'${candidate}' resolves outside '${t}'` };
}

/**
 * The writer's half: a scratch directory under the OS temp dir, asserted to be outside the
 * measured tree before it is handed out. If the assertion fails the directory is removed by
 * the process that made it, then the refusal is thrown — never returned as an approximation.
 *
 *   const scratch = makeScratchDir("vb-accept-root-", { tree: TREE });
 */
export function makeScratchDir(prefix, { tree }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const verdict = outsideTree(dir, tree);
  if (!verdict.ok) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    const err = new Error(verdict.why);
    err.refused = verdict.refused;
    throw err;
  }
  return dir;
}

/**
 * Git's local plumbing (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …), stripped.
 *
 * FIELD FINDING (2026-09-25, this bead's own fixture): git exports those variables
 * into every child it starts, and GIT_DIR OUTRANKS `-C` — so inside a pre-push hook,
 * `git -C <fixture> config user.name …` writes the PUSHED repository's config. This
 * fixture did exactly that to the real voicebox checkout during a gate run (user.name
 * 'Tree-dirt fixture') and was caught in the field. A measurement (or a fixture) of a
 * tree must not be steerable by the environment of whatever ran it — the same rule as
 * the rest of this module, one layer down.
 *
 * The names come from git itself, so a future git variable is covered without an edit.
 */
let localGitEnvNames = null;
function gitLocalEnvNames() {
  if (localGitEnvNames) return localGitEnvNames;
  try {
    localGitEnvNames = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    localGitEnvNames = []; // no git: nothing to strip; callers fail on their own terms
  }
  return localGitEnvNames;
}

/**
 * The environment for running a git command AGAINST A NAMED TREE: process.env minus git's
 * own local plumbing. Use it wherever the answer must be about `tree` rather than about
 * whatever repository the caller happens to be inside.
 */
export function gitEnv() {
  const env = { ...process.env };
  for (const name of gitLocalEnvNames()) delete env[name];
  return env;
}

/**
 * A tree's dirt, as `git status --porcelain` lines, `.beads/` excluded (its untracked sync dir
 * is not a writer's artefact — voicebox-beads-590's F6). `--untracked-files=all` so a file
 * appearing INSIDE an untracked directory is visible: the Dolt backup case was exactly that
 * shape, one `?? backup/` line that never changed while files kept landing in it.
 *
 * Runs with `gitEnv()`: a `GIT_DIR` inherited from a hook would otherwise answer this question
 * about the WRONG repository — the field finding above, in the measurement itself.
 */
export function porcelainLines(tree) {
  let out = "";
  try {
    out = execFileSync("git", ["-C", tree, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", env: gitEnv() });
  } catch {
    return []; // not a repository, or git unavailable: no measurement, no invented one
  }
  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.includes(".beads/"));
}

/**
 * What changed between two snapshots. `added` is THIS run's writing — the only thing a check
 * about a run may blame on the run. `preExisting` is dirt that was already there, reported as
 * such so the next person does not chase a file no author wrote (bp8's whole complaint).
 */
export function dirtDelta(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((line) => !b.has(line)),
    removed: before.filter((line) => !a.has(line)),
    preExisting: before.filter((line) => a.has(line)),
  };
}
