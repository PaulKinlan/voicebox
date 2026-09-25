// lib/git-env.mjs — git's local plumbing (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …), stripped.
//
// FIELD FINDING (2026-09-25, voicebox-beads-bp8's own fixture): git exports those variables
// into every child it starts, and GIT_DIR OUTRANKS `-C` — so inside a pre-push hook,
// `git -C <fixture> config user.name …` writes the PUSHED repository's config. A fixture did
// exactly that to the real voicebox checkout during a gate run (user.name 'Tree-dirt fixture')
// and was caught in the field. A measurement (or a fixture) of a tree must not be steerable by
// the environment of whatever ran it.
//
// voicebox-beads-bbb: this module is the NEUTRAL home — the helper began in tools/tree-dirt.mjs
// and moved here so scripts/ and tests/ can strip without importing a tools/ module.
//
// The names come from git itself, so a future git variable is covered without an edit.

import { execFileSync } from "node:child_process";

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
 * whatever repository the caller happens to be inside — a hook exports GIT_DIR and it
 * outranks `-C`.
 */
export function gitEnv() {
  const env = { ...process.env };
  for (const name of gitLocalEnvNames()) delete env[name];
  return env;
}
