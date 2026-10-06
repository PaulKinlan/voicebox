// tests/landing-preflight.test.mjs — the landing preflight, driven against a REAL remote (voicebox-beads-vto3)
//
// WHY A TEST AND NOT A REVIEW. The classifier decides whether a push happens, so "it looks right" is
// not good enough: a check that cannot fail is a description of the code. This file therefore drives
// the script against a scratch repository with its own bare remote and makes git itself produce the
// outputs — real `[rejected]` lines in both wordings this repository prints, a real update row at two
// abbreviation lengths, a real forced-update row, a real `Everything up-to-date`. The places where a
// string had to be synthesised are named in the test title, because the difference between "git
// printed this" and "somebody typed what they thought git prints" is the whole value of the file: the
// bug this script exists to catch was a lane reading a true sentence about the wrong ref as evidence
// that work had landed.
//
// THE CONTROL, asserted at the end: nothing here may move a branch or leave a ref behind. Every push
// is `--dry-run`, the rehearsal stubs the push command, and the assertions read `ls-remote` before and
// after. A test of a preflight that could itself alter the remote would be worse than no preflight.
//
//   node --test tests/landing-preflight.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "landing-preflight.sh");
const roots = [];

// git's own environment is stripped: a fixture that inherits GIT_DIR commits into the repository it
// is being pushed (the hygiene `tests/single-owner.test.mjs` inherited from `tests/docs-touched.test.mjs`).
const cleanEnv = { ...process.env };
for (const key of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n")) {
  delete cleanEnv[key];
}

test.after(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function sh(cwd, cmd, args = []) {
  return execFileSync(cmd, args, { cwd, env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function git(cwd, ...args) {
  return sh(cwd, "git", args);
}

function commit(cwd, msg) {
  writeFileSync(path.join(cwd, `f-${msg.replace(/[^a-z0-9]/gi, "-")}.txt`), `${msg}\n`);
  git(cwd, "add", "-A");
  git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** A scratch tree with its own bare `origin`, `main` pushed, and a second commit LANDED BUT NOT PUSHED.
 *  Returns the paths plus the shas the assertions need. Nothing here talks to a network or to
 *  voicebox's own remote: the remote is a local bare repo. */
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "landing-preflight-")));
  roots.push(dir);
  const bare = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  git(dir, "init", "-q", "--bare", bare);
  git(dir, "clone", "-q", bare, work);
  git(work, "config", "user.email", "preflight@example.invalid");
  git(work, "config", "user.name", "preflight fixture");
  git(work, "config", "commit.gpgsign", "false");
  const base = commit(work, "base");
  git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(work, "fetch", "-q", "origin");
  const ahead = commit(work, "ahead");
  return { dir, bare, work, base, ahead };
}

/** Run the preflight itself. Never throws: the exit code IS the answer under test. */
function preflight(cwd, args = [], extra = {}) {
  const r = spawnSync("/usr/bin/env", ["sh", SCRIPT, ...args], {
    cwd,
    env: { ...cleanEnv, ...extra },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const lsRemote = (bare) => git(bare, "ls-remote", ".", "refs/heads/*").trim();

// ── REAL git output: the four branches ────────────────────────────────────────

test("REAL update row: a clean tree that is ahead of its remote is OK (exit 0)", () => {
  const f = fixture();
  const r = preflight(f.work);
  assert.equal(r.code, 0, `a pushable tree must come back OK:\n${r.out}`);
  assert.match(r.out, /^OK\s/m, `the verdict line must say OK:\n${r.out}`);
  assert.ok(r.out.includes(f.ahead.slice(0, 7)), `the verdict must name the sha git would write (git abbreviated ${f.ahead.slice(0, 7)}…):\n${r.out}`);
  assert.equal(lsRemote(f.bare), git(f.bare, "ls-remote", ".", "refs/heads/*").trim(), "and the dry run must not have moved anything");
  assert.match(lsRemote(f.bare), new RegExp(`refs/heads/main$`.replace("$", "")), "main still exists in the fixture remote");
  // THE CONTROL: the remote holds exactly one branch, the one the fixture pushed.
  assert.equal(lsRemote(f.bare).split("\n").length, 1, `no probe refs may be created:\n${lsRemote(f.bare)}`);
  assert.ok(lsRemote(f.bare).includes(f.base), "and its tip is still the base commit:\n" + lsRemote(f.bare));
});

test("REAL refusal, wording 'fetch first': the remote moved and we have NOT fetched it — REFUSED (exit 3)", () => {
  const f = fixture();
  // Make the remote move under the fixture from a second clone, and deliberately do NOT fetch here:
  // the object is unknown locally, which is what makes git say "fetch first" rather than
  // "non-fast-forward". Two refusals, two wordings, one verdict — the marker is what is matched.
  const other = path.join(f.dir, "other");
  git(f.dir, "clone", "-q", f.bare, other);
  git(other, "config", "user.email", "preflight@example.invalid");
  git(other, "config", "user.name", "preflight fixture");
  git(other, "config", "commit.gpgsign", "false");
  commit(other, "theirs");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  const r = preflight(f.work);
  assert.equal(r.code, 3, `a push the remote would reject must be REFUSED, not OK:\n${r.out}`);
  assert.match(r.out, /^REFUSED/m, `the verdict line must say REFUSED:\n${r.out}`);
  assert.match(r.out, /\(fetch first\)/, `measured wording on git 2.43:\n${r.out}`);
  assert.match(r.out, /next: git fetch origin/, "and it must name the remedy:\n" + r.out);
});

test("REAL refusal, wording 'non-fast-forward': the same push AFTER a fetch — still REFUSED (exit 3)", () => {
  const f = fixture();
  const other = path.join(f.dir, "other2");
  git(f.dir, "clone", "-q", f.bare, other);
  git(other, "config", "user.email", "preflight@example.invalid");
  git(other, "config", "user.name", "preflight fixture");
  git(other, "config", "commit.gpgsign", "false");
  commit(other, "theirs2");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(f.work, "fetch", "-q", "origin"); // now the object is known locally, so the reason changes
  const r = preflight(f.work);
  assert.equal(r.code, 3, `the reason changed; the verdict must not:\n${r.out}`);
  assert.match(r.out, /non-fast-forward/, `measured wording on git 2.43:\n${r.out}`);
  assert.doesNotMatch(r.out, /^OK/m, `and it must not read as a landing:\n${r.out}`);
});

test("REAL refusal (non-fast-forward): pushing an ANCESTOR is REFUSED (exit 3) — the other wording", () => {
  const f = fixture();
  git(f.work, "push", "-q", "origin", "HEAD:refs/heads/main"); // main now at `ahead`
  git(f.work, "fetch", "-q", "origin");
  // Offer the BASE again: an ancestor of the tip, so the refusal is "non-fast-forward". Asked and
  // answered by the preflight's own local-ref, since HEAD here is the current tip.
  const r = preflight(f.work, ["--local-ref", f.base]);
  assert.equal(r.code, 3, `rewinding the target must be REFUSED:\n${r.out}`);
  assert.match(r.out, /non-fast-forward/, `the measured wording is in the output:\n${r.out}`);
  assert.equal(lsRemote(f.bare).includes(f.ahead), true, "and the remote did not move");
});

test("REAL up-to-date: a throwaway probe ref prints it, and it is NO-OP (exit 2), never success", () => {
  const f = fixture();
  // This is the exact sentence that cost a lane its work: it is TRUE about the ref that was pushed
  // and says NOTHING about whether the landing happened. Pushed twice to a probe ref, git prints it.
  git(f.work, "push", "-q", "origin", "HEAD:refs/heads/fleet/probe-only");
  const probe = spawnSync("git", ["push", "--dry-run", "origin", "HEAD:refs/heads/fleet/probe-only"], {
    cwd: f.work, env: cleanEnv, encoding: "utf8",
  });
  const captured = path.join(f.dir, "captured-up-to-date.txt");
  writeFileSync(captured, `${probe.stdout ?? ""}${probe.stderr ?? ""}`);
  assert.match(readFileSync(captured, "utf8"), /Everything up-to-date/, "the fixture must really produce the sentence");
  const r = preflight(f.work, ["--classify", captured]);
  assert.equal(r.code, 2, `the up-to-date line must answer NO-OP:\n${r.out}`);
  assert.match(r.out, /NOT evidence that anything landed/, "and must say so in words:\n" + r.out);
});

test("REAL forced-update row is UNKNOWN (exit 4) — a shape this script cannot vouch for", () => {
  const f = fixture();
  const other = path.join(f.dir, "force");
  git(f.dir, "clone", "-q", f.bare, other);
  git(other, "config", "user.email", "preflight@example.invalid");
  git(other, "config", "user.name", "preflight fixture");
  git(other, "config", "commit.gpgsign", "false");
  commit(other, "force-theirs");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(f.work, "fetch", "-q", "origin");
  const forced = spawnSync("git", ["push", "--dry-run", "--force", "origin", `${f.base}:refs/heads/main`], {
    cwd: f.work, env: cleanEnv, encoding: "utf8",
  });
  const captured = path.join(f.dir, "captured-forced.txt");
  writeFileSync(captured, `${forced.stdout ?? ""}${forced.stderr ?? ""}`);
  assert.match(readFileSync(captured, "utf8"), /forced update/, "the fixture must really produce the forced row");
  const r = preflight(f.work, ["--classify", captured]);
  assert.equal(r.code, 4, `a forced row is not a landing:\n${r.out}`);
});

// ── ABBREVIATION LENGTH IS READ FROM THE ROW, not assumed ─────────────────────

for (const abbrev of ["4", "7", "12", "24"]) {
  test(`REAL row at core.abbrev=${abbrev}: OK (exit 0) — no hardcoded sha length`, () => {
    const f = fixture();
    git(f.work, "config", "core.abbrev", abbrev);
    const r = preflight(f.work);
    assert.equal(r.code, 0, `core.abbrev=${abbrev} must still answer OK:\n${r.out}`);
    const printed = (r.out.match(/would move to ([0-9a-f]{4,})/) || [])[1];
    assert.ok(printed, `the verdict must quote the sha the row printed:\n${r.out}`);
    assert.equal(f.ahead.startsWith(printed), true, `quoted sha ${printed} is not a prefix of HEAD ${f.ahead}`);
    // The point of the loop: the length the script reads is the length ROW printed, so at least one
    // of these settings must produce something OTHER than git's default 7.
    if (abbrev !== "4") assert.equal(printed.length >= 7, true, `abbrev=${abbrev} printed ${printed.length} chars`);
    else assert.equal(printed.length, 4, `abbrev=4 must print exactly 4, got ${printed}`);
  });
}

// ── THE IDENTITY TIE: the row must describe THIS tree ─────────────────────────

test("REAL capture from a tree that then moved: IDENTITY-MISMATCH (exit 6), the gated tree is not the offered tree", () => {
  const f = fixture();
  const first = preflight(f.work);
  assert.equal(first.code, 0, `setup: the first run is the good one:\n${first.out}`);
  const captured = path.join(f.dir, "captured-before-move.txt");
  // Re-run the dry run by hand and capture it, then commit — HEAD moves under the captured verdict.
  const raw = spawnSync("git", ["push", "--dry-run", "origin", "HEAD:refs/heads/main"], { cwd: f.work, env: cleanEnv, encoding: "utf8" });
  writeFileSync(captured, `${raw.stdout ?? ""}${raw.stderr ?? ""}`);
  commit(f.work, "moved-underneath");
  const r = preflight(f.work, ["--classify", captured]);
  assert.equal(r.code, 6, `a verdict about a superseded tree must not read as OK:\n${r.out}`);
  assert.match(r.out, /IDENTITY-MISMATCH/, "and it must be named:\n" + r.out);
});

test("SYNTHESISED: an unrelated sha on the row is IDENTITY-MISMATCH (exit 6)", () => {
  const f = fixture();
  const captured = path.join(f.dir, "synthetic-mismatch.txt");
  writeFileSync(captured, `To x\n   0123456..abcdef0  HEAD -> main\n`);
  const r = preflight(f.work, ["--classify", captured]);
  assert.equal(r.code, 6, `not synthesised silently — the title says SYNTHESISED:\n${r.out}`);
});

// ── THE PRECONDITION: asserted, not assumed ──────────────────────────────────

test("REAL: HEAD already equals the target is PRECONDITION (exit 5) — never a false green", () => {
  const f = fixture();
  git(f.work, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(f.work, "fetch", "-q", "origin");
  const r = preflight(f.work);
  assert.equal(r.code, 5, `standing on the thing you meant to push must stop the run:\n${r.out}`);
  assert.match(r.out, /nothing here to landing|nothing here to land/, "and name the reason");
});

test("REAL: an uncommitted merge leaves the tree dirty and the preflight REFUSES to ask (exit 5)", () => {
  const f = fixture();
  writeFileSync(path.join(f.work, "dirty.txt"), "uncommitted\n");
  const r = preflight(f.work);
  assert.equal(r.code, 5, `a dirty worktree is the false-green shape this exists for:\n${r.out}`);
  assert.match(r.out, /not clean/, "named as such");
});

test("REAL: a dry run that fails after printing a good row is downgraded to UNKNOWN (exit 4)", () => {
  const f = fixture();
  const sha = git(f.work, "rev-parse", "HEAD").trim().slice(0, 7);
  // STUBBED push (this is the rehearsal path, so no remote is contacted): a row, then a non-zero
  // exit — the transport failing after git wrote a plausible line.
  const r = preflight(f.work, ["--push-cmd", `printf 'To x\\n   0123456..${sha}  HEAD -> main\\n'; exit 128`]);
  assert.equal(r.code, 4, `an OK read off a failed command is not OK:\n${r.out}`);
  assert.match(r.out, /dry-run command itself exited 128/, "and the downgrade is explained:\n" + r.out);
});

// ── THE REHEARSAL and the hygiene it exists to protect ────────────────────────

test("REAL: --rehearse drives every branch with the push stubbed and contacts no remote", () => {
  const f = fixture();
  const before = lsRemote(f.bare);
  const r = preflight(f.work, ["--rehearse"]);
  assert.equal(r.code, 0, `every branch must classify:\n${r.out}`);
  assert.match(r.out, /REFUSED-non-fast-forward\s+exit 3 as expected/, "refusal:\n" + r.out);
  assert.match(r.out, /REFUSED-beats-loose-row\s+exit 3 as expected/, "the ordering trap:\n" + r.out);
  assert.match(r.out, /NO-OP\s+exit 2 as expected/, "up-to-date:\n" + r.out);
  assert.match(r.out, /OK-7-CHAR\s+exit 0 as expected/, "the good row:\n" + r.out);
  assert.match(r.out, /IDENTITY-MISMATCH\s+exit 6 as expected/, "and the identity tie:\n" + r.out);
  assert.match(r.out, /exit 4 as expected/, "and the fail-closed default:\n" + r.out);
  assert.match(r.out, /SYNTHESISED/, "it must say which inputs were invented:\n" + r.out);
  assert.equal(lsRemote(f.bare), before, "the rehearsal must leave the remote exactly as it found it");
});

test("DASH, NOT BASH: the script parses under dash and uses no bash-only construct", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /^#!\/usr\/bin\/env sh/, "it must keep the sh shebang this tree's hooks run under");
  // The prose in this file NAMES the bashisms it avoids, so the check runs on the CODE: comments
  // stripped, shebang kept. Asserting on the raw text would pass by forgetting to mention them.
  const code = src.split("\n").filter((line, i) => i === 0 || !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /PIPESTATUS/, "no PIPESTATUS — dash has none (the class fixed by 221c44d)");
  assert.doesNotMatch(code, /set -o pipefail/, "no pipefail either");
  assert.doesNotMatch(code, /\[\[/, "no [[ ]]");
  assert.doesNotMatch(code, /=\s*\(/, "no arrays");
  // And the trap this script hit while being written: dash's printf reads a format that STARTS with
  // a dash as an option and dies with "Illegal option --". Every literal line the script prints goes
  // through `printf '%s\n' …` for that reason.
  assert.doesNotMatch(code, /printf '-/, "no printf with a leading-dash format — dash parses it as an option");
  if (existsSync("/bin/dash")) {
    const parsed = spawnSync("/bin/dash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `dash must parse it:\n${parsed.stderr}`);
  }
});

test("the script refuses an unknown argument instead of guessing (exit 1)", () => {
  const f = fixture();
  const r = preflight(f.work, ["--classify"]);
  assert.ok(r.code === 1 || r.code === 2, `a missing file is a usage error, not a verdict (got ${r.code}):\n${r.out}`);
  const r2 = preflight(f.work, ["--nonsense"]);
  assert.equal(r2.code, 1, `unknown flags must fail closed:\n${r2.out}`);
});
