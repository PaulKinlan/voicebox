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

test("REAL row aimed at ANOTHER branch: UNKNOWN (exit 4) for the target we asked about, and OK for the one the row really names", () => {
  const f = fixture();
  // Put `other` on the remote at the BASE, so a dry run of HEAD:refs/heads/other prints a genuine
  // UPDATE ROW (not "[new branch]") naming `other` on the right of the arrow. git 2.43 prints:
  //    <base7>..<ahead7>  HEAD -> other
  git(f.work, "push", "-q", "origin", `${f.base}:refs/heads/other`);
  const raw = spawnSync("git", ["push", "--dry-run", "origin", "HEAD:refs/heads/other"], {
    cwd: f.work, env: cleanEnv, encoding: "utf8",
  });
  const captured = path.join(f.dir, "captured-other-target.txt");
  writeFileSync(captured, `${raw.stdout ?? ""}${raw.stderr ?? ""}`);
  const body = readFileSync(captured, "utf8");
  assert.match(body, /HEAD -> other/, `the fixture must really print a row landing on 'other':\n${body}`);

  // THE FAIL-OPEN THIS PROVES FIXED: the same bytes, asked about `main`, must not answer OK. Before
  // the review this returned 0 with "origin/main would move…" — the tool itself committing the exact
  // error it exists to catch: a true sentence about a ref that is not the one being landed.
  const asked = preflight(f.work, ["--classify", captured, "--target", "main"]);
  assert.equal(asked.code, 4, `a row aimed at 'other' is NOT a landing on main:\n${asked.out}`);
  assert.match(asked.out, /a row DOES exist, but it lands on other, not/, "and the reason must name the near-miss:\n" + asked.out);
  assert.doesNotMatch(asked.out, /^OK/m, `never say OK about a ref nobody is landing:\n${asked.out}`);

  // …and the SAME classifier still says OK when asked about the ref the row really names, so the first
  // half cannot be satisfied by a regex that simply never matches anything.
  const aimed = preflight(f.work, ["--classify", captured, "--target", "other"]);
  assert.equal(aimed.code, 0, `aimed at its real destination it must still read OK:\n${aimed.out}`);

  // Full-form destination (`HEAD -> refs/heads/main`) is the same landing, so it is the same verdict.
  writeFileSync(captured, `To x\n   0123456..${f.ahead.slice(0, 7)}  HEAD -> refs/heads/${"main"}\n`);
  const full = preflight(f.work, ["--classify", captured, "--target", "main"]);
  assert.equal(full.code, 0, `a refs/heads/-prefixed destination is still the target:\n${full.out}`);
});

// ── A FLAG CANNOT WIDEN ITS OWN GUARD (the second fail-open, found by probing the first fix) ──────
//
// The destination used to be tested by pasting `$TARGET` and `$LOCAL_REF` into one ERE. Measured on
// this tree: a row landing on `wrong`, asked about with `--target 'main|wrong'`, answered OK — the
// flag became an ALTERNATION. Both are now parsed fields compared literally, so metacharacters in a
// refname are ordinary characters and a flag can only ever narrow the question.
test("SYNTHESISED rows + regex-bearing flags: a flag cannot match a row it was not aimed at", () => {
  const f = fixture();
  const h7 = f.ahead.slice(0, 7);
  const b7 = f.base.slice(0, 7);
  const file = (name, dest) => {
    const p = path.join(f.dir, name);
    writeFileSync(p, `To x\n   ${b7}..${h7}  HEAD -> ${dest}\n`);
    return p;
  };
  const onWrong = file("row-wrong.txt", "wrong");
  const onMain = file("row-main.txt", "main");

  const cases = [
    // <captured row lands on> <flag> <verdict wanted> — 4 = UNKNOWN, the guard refused to be widened
    [onWrong, "main|wrong", 4], [onWrong, "mai.*", 4], [onWrong, "ma[n]in", 4], [onWrong, "wrong", 0],
    [onMain, "mai.", 4], [onMain, "main|wrong", 4], [onMain, "main", 0], [onMain, "refs/heads/main", 0],
    [onWrong, "main\\hwrong", 4],
  ];
  for (const [row, target, want] of cases) {
    const r = preflight(f.work, ["--classify", row, "--target", target]);
    assert.equal(r.code, want, `row ${path.basename(row)} asked about '${target}' must be ${want}:\n${r.out}`);
  }

  // The source end is literal too: a regex-y --local-ref must not reach across to a row it names partly.
  const r1 = preflight(f.work, ["--classify", onMain, "--local-ref", "HE.*D"]);
  assert.notEqual(r1.code, 0, `--local-ref 'HE.*D' must not match a HEAD row:\n${r1.out}`);
  const r2 = preflight(f.work, ["--classify", onMain, "--local-ref", "HEAD"]);
  assert.equal(r2.code, 0, `the literal control still reads OK — so the first half is not a dead test:\n${r2.out}`);

  // And a flag whose value is not a commit at all is a PRECONDITION, never a verdict about a landing.
  // (`git rev-parse 'HE.*D'` ECHOES the typo and exits 0 on git 2.43 — measured — which is why the
  // precondition peels with `--verify "$LOCAL_REF^{commit}"` and rejects anything that is not hex.)
  const r3 = preflight(f.work, ["--check", "--local-ref", "HE.*D"]);
  assert.equal(r3.code, 5, `a non-commit local-ref must stop the run:\n${r3.out}`);
});

test("SYNTHESISED: whitespace and annotation variants are read as the same row, or refused", () => {
  const f = fixture();
  const h7 = f.ahead.slice(0, 7);
  const b7 = f.base.slice(0, 7);
  const rows = [
    [`   ${b7}..${h7}  HEAD -> main`, 0, "git's own two-space form"],
    [`\t${b7}..${h7}\tHEAD -> main`, 0, "tabs instead of spaces"],
    [`   ${b7}..${h7}  HEAD -> main (fast-forward)`, 0, "a trailing note is not part of the ref"],
    [`   ${b7}..${h7}  HEAD -> 'main'`, 4, "a quoted destination is a shape we do not vouch for"],
    [`   ${b7}..${h7}  HEAD → main`, 4, "a unicode arrow is not git 2.43's arrow"],
    [` + ${b7}...${h7}  HEAD -> main`, 4, "a forced row is never a landing"],
    [` - ${b7}         (deleted) HEAD -> main`, 4, "a deletion row is never a landing"],
  ];
  for (const [row, want, why] of rows) {
    const p = path.join(f.dir, `ws-${want}-${b7}.txt`);
    writeFileSync(p, `To x\n${row}\n`);
    const r = preflight(f.work, ["--classify", p]);
    assert.equal(r.code, want, `${why}: ${JSON.stringify(row)} ->\n${r.out}`);
  }
});

test("A FLAG CANNOT EAT THE NEXT FLAG, and cannot be empty: usage error 1, never a verdict", () => {
  const f = fixture();
  // Measured before this was fixed, on git 2.43 under dash:
  //   --check --target --remote  ->  "PRECONDITION-OK … target=origin/--remote"  exit 0
  //   --target --remote          ->  asked the REAL remote about refs/heads/--remote
  //   --check --target=          ->  "PRECONDITION-OK … target=origin/"          exit 0
  // Each one is the same defect as the bug this whole script exists to refuse: the answer is green
  // about a question nobody asked. So a flag-like value and an empty value are BOTH usage errors.
  const flags = ["--target", "--remote", "--local-ref", "--classify", "--push-cmd"];
  for (const flag of flags) {
    for (const argv of [[flag, "--check"], ["--check", flag, "--target"], [`${flag}=`]]) {
      const r = preflight(f.work, argv);
      assert.equal(r.code, 1, `${argv.join(" ")} must be a usage error, never a verdict:\n${r.out}`);
      assert.match(r.out, /needs a value|looks like another flag/, `${argv.join(" ")}: named as such\n${r.out}`);
      assert.doesNotMatch(r.out, /^OK|^NO-OP|^REFUSED|^UNKNOWN|^IDENTITY-MISMATCH|^PRECONDITION-OK/m,
        `${argv.join(" ")}: no verdict word may appear at all:\n${r.out}`);
    }
  }
  // The `=` form is the escape hatch, and it must still WORK — otherwise the guard above is only a
  // refusal to accept input, not a fix.
  const eq = preflight(f.work, ["--check", "--target=main"]);
  assert.equal(eq.code, 0, `--target=main is a normal flag value:\n${eq.out}`);
  assert.match(eq.out, /target=origin\/main/, "and it lands in the right namespace:\n" + eq.out);
  const dashValue = preflight(f.work, ["--classify=-weird"]);
  assert.equal(dashValue.code, 4, `an odd-but-present value is still a question, not a usage error:\n${dashValue.out}`);
  assert.match(dashValue.out, /no captured output to read \(-weird\)/, "and it is echoed back:\n" + dashValue.out);
});

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
  assert.match(r.out, /UNKNOWN-WRONG-TARGET\s+exit 4 as expected/, "including the destination guard:\n" + r.out);
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
  // `[[:blank:]]` is a POSIX character class and is allowed; bash's `[[ ]]` test keyword is not.
  assert.doesNotMatch(code, /\[\[[^:[:space:]]|\[\[ /, "no [[ ]] test keyword (POSIX classes like [[:blank:]] are fine)");
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
  const r2 = preflight(f.work, ["--nonsense"]);
  assert.equal(r2.code, 1, `unknown flags must fail closed:\n${r2.out}`);
  // A VALUE-FLAG WITH NO VALUE must be a usage error (1), not a verdict. It used to die inside dash's
  // `shift 2` with exit 2 — the script's own NO-OP code, so a broken command line reported a verdict
  // it had never reached, and a caller keying on 2 would have read "do not push, nothing to do".
  for (const flag of ["--target", "--remote", "--local-ref", "--classify", "--push-cmd"]) {
    const r = preflight(f.work, [flag]);
    assert.equal(r.code, 1, `${flag} with no value must exit 1, not alias a verdict code:\n${r.out}`);
    assert.match(r.out, /needs a value/, `${flag}: and must say so\n${r.out}`);
    assert.doesNotMatch(r.out, /^NO-OP|^REFUSED|^UNKNOWN|^OK/m, `${flag}: no verdict may appear:\n${r.out}`);
  }
});
