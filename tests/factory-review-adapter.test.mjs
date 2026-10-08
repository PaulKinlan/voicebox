import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  selectReviewStation,
  computeReviewCacheKey,
  routeIssue,
  PRIORITY_ORDER,
  CATEGORY_STATIONS,
} from "../tools/factory-issue-router.mjs";
import { formatTriageComment, sanitizeFindingText } from "../tools/factory-issue-commenter.mjs";
import {
  runReviewTrigger,
  parsePublisherSummary,
  sanitizeLogOutput,
  locateRunDeltaReport,
  getCheckoutRepoIdentity,
  validateStationReportProvenance,
} from "../scripts/factory-review-trigger.mjs";
import { pollInboundIssues } from "../scripts/factory-issue-poller.mjs";
import { publishNightlyFindings } from "../scripts/factory-nightly-publisher.mjs";
import { runReviewWatcher } from "../scripts/factory-review-watcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("factory-review-adapter: deterministic station selection and priority ordering (Security > Perf > UX > Docs > Ops)", () => {
  // 1. Security priority
  const secSel = selectReviewStation(["lib/redact.mjs", "lib/tasks.mjs"]);
  assert.equal(secSel.station, "secret-scan");
  assert.equal(secSel.category, "security");
  assert.ok(secSel.deferred.some((d) => d.category === "perf"));

  // 2. Perf priority over UX and docs
  const perfSel = selectReviewStation(["lib/tasks.mjs", "public/index.html", "docs/README.md"]);
  assert.equal(perfSel.station, "perf-review");
  assert.equal(perfSel.category, "perf");
  assert.ok(perfSel.deferred.some((d) => d.category === "ux"));
  assert.ok(perfSel.deferred.some((d) => d.category === "docs"));

  // 3. UX priority over docs
  const uxSel = selectReviewStation(["public/style.css", "docs/07-architecture.md"]);
  assert.equal(uxSel.station, "ui-ux-audit");
  assert.equal(uxSel.category, "ux");
  assert.ok(uxSel.deferred.some((d) => d.category === "docs"));

  // 4. Docs only
  const docsSel = selectReviewStation(["docs/28-factory-review-adapter.md"]);
  assert.equal(docsSel.station, "docs-drift");
  assert.equal(docsSel.category, "docs");
  assert.equal(docsSel.deferred.length, 0);

  // 5. Fallback for ops
  const opsSel = selectReviewStation(["scripts/random-tool.sh"]);
  assert.equal(opsSel.station, "log-check");
  assert.equal(opsSel.category, "ops");
});

test("factory-review-adapter: bounded review cap strictly enforces at most 1 station per review with explicit deferred recording", () => {
  const mixedDiff = [
    "lib/redact.mjs",       // Security
    "lib/tasks.mjs",        // Perf
    "public/style.css",     // UX
    "docs/README.md",       // Docs
    "scripts/deploy.sh",    // Ops
  ];

  const sel = selectReviewStation(mixedDiff);
  assert.equal(sel.station, "secret-scan", "highest priority security station selected");
  assert.equal(sel.matchedCategories.length, 5, "all 5 categories detected");

  // Deferred list must record secondary stations for nightly line
  assert.equal(sel.deferred.length, 4);
  const deferredStations = sel.deferred.map((d) => d.station);
  assert.deepEqual(deferredStations, ["perf-review", "ui-ux-audit", "docs-drift", "log-check"]);
});

test("factory-review-adapter: deterministic cache key includes diff content, station, and factory revision", () => {
  const key1 = computeReviewCacheKey({
    diffContent: "diff --git a/foo b/foo\n+line",
    station: "perf-review",
    factoryRef: "1e970d595748a7c38b7fd39417e055165d7edecd",
  });

  const key2 = computeReviewCacheKey({
    diffContent: "diff --git a/foo b/foo\n+line",
    station: "perf-review",
    factoryRef: "1e970d595748a7c38b7fd39417e055165d7edecd",
  });
  assert.equal(key1, key2, "identical inputs produce identical fingerprint");

  // Station change invalidates
  const keyStation = computeReviewCacheKey({
    diffContent: "diff --git a/foo b/foo\n+line",
    station: "ui-ux-audit",
    factoryRef: "1e970d595748a7c38b7fd39417e055165d7edecd",
  });
  assert.notEqual(key1, keyStation);

  // Repository target change invalidates
  const keyRepo = computeReviewCacheKey({
    diffContent: "diff --git a/foo b/foo\n+line",
    station: "perf-review",
    factoryRef: "1e970d595748a7c38b7fd39417e055165d7edecd",
    repo: "OtherOwner/voicebox",
  });
  assert.notEqual(key1, keyRepo, "different repository target produces distinct cache key");

  // Factory ref change invalidates
  const keyRef = computeReviewCacheKey({
    diffContent: "diff --git a/foo b/foo\n+line",
    station: "perf-review",
    factoryRef: "2222222222222222222222222222222222222222",
  });
  assert.notEqual(key1, keyRef);
});

test("factory-issue-router: loop hazard guard rejects publisher issues independent of author association", () => {
  // Case A: Publisher issue authored by OWNER (must still be refused!)
  const ownerPublisherIssue = {
    number: 17,
    author_association: "OWNER",
    title: "[factory/high] perf-review: Startup probe blocks the boot banner",
    body: "**Station**: `perf-review`\n<!-- factory-fingerprint: 5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a -->\n<!-- factory-self-test -->",
  };
  const resA = routeIssue(ownerPublisherIssue);
  assert.equal(resA.ok, false);
  assert.equal(resA.reason, "already a published factory finding, not an inbound report");

  // Case B: Upstream factory github-issues sink format ([factory:agent] + **Fingerprint**:)
  const upstreamSinkIssue = {
    number: 18,
    author_association: "MEMBER",
    title: "[factory:accessibility] Missing alt tag on home banner",
    body: "**Rule**: img-alt\n**Fingerprint**: `abcdef0123456789abcdef0123456789`\n### Description",
  };
  const resB = routeIssue(upstreamSinkIssue);
  assert.equal(resB.ok, false);
  assert.equal(resB.reason, "already a published factory finding, not an inbound report");

  // Case C: Legitimate human report with member association (admitted)
  const humanIssue = {
    number: 19,
    author_association: "MEMBER",
    title: "Bug: slow audio playback on startup",
    body: "Noticing performance latency in the audio client stream",
  };
  const resC = routeIssue(humanIssue);
  assert.equal(resC.ok, true);
  assert.ok(resC.categories.includes("perf"));
  assert.ok(resC.agents.includes("perf-review"));

  // Case C2: gh issue list returns camelCase authorAssociation
  const ghCliIssue = {
    number: 21,
    authorAssociation: "COLLABORATOR",
    title: "Docs typo in architecture document",
    body: "Please update docs/07-architecture.md",
  };
  const resC2 = routeIssue(ghCliIssue);
  assert.equal(resC2.ok, true);
  assert.ok(resC2.categories.includes("docs"));
  assert.ok(resC2.agents.includes("docs-drift"));

  // Case D: External contributor / newcomer author (NONE) is admitted and routed
  const newcomerIssue = {
    number: 20,
    author_association: "NONE",
    title: "Security vulnerability report",
    body: "Found potential token leak in credentials",
  };
  const resD = routeIssue(newcomerIssue);
  assert.equal(resD.ok, true, "newcomers and external contributors must be admitted");
  assert.ok(resD.categories.includes("security"));
  assert.ok(resD.agents.includes("secret-scan"));

  // Case E: Pull requests skipped (handled by review trigger, not issue poller)
  const prIssue = {
    number: 22,
    author_association: "OWNER",
    title: "feat(audio): client audio improvements",
    body: "Implements audio buffer improvements",
    pull_request: { url: "https://api.github.com/repos/PaulKinlan/voicebox/pulls/22" },
  };
  const resE = routeIssue(prIssue);
  assert.equal(resE.ok, false);
  assert.ok(resE.reason.includes("pull request, not an issue"));
});

test("factory-issue-commenter: parses real factory delta reports, emits one comment per finding, and sanitizes credentials", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-report-tmp");
  mkdirSync(tmpDir, { recursive: true });

  // Real factory delta format with hyphenated target prefix: voicebox-miniapps-perf-review-delta.md
  const perfReport = `# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.485838+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [HIGH] Startup probe blocks the boot banner (\`new\`)
- **Rule**: \`blocking-boot-probe\`
- **Location**: \`server.mjs:210\`
- **Fingerprint**: \`5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a\`
- **Description**: the probe is awaited before the banner prints
- **Snippet**: \`await probeAll()\`
- **Remediation**: Do not await the probe before printing the banner

## Triaged False Positives (not counted, never published)

### [FALSE POSITIVE] Ignored candidate on same file (\`fixed\`)
- **Rule**: \`ignored-rule\`
- **Location**: \`server.mjs:220\`
`;

  // Real factory delta format for secret-scan (security station) with credential in rule and location
  const secretReport = `# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.485721+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [CRITICAL · routed CRITICAL] Hardcoded API credential in config (\`new\`)
- **Rule**: \`generic-api-key-with-token=supersecretkey\`
- **Location**: \`config/session.txt?sid=violetfox\`
- **Fingerprint**: \`a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0\`
- **Description**: credential token ghp_ABCDEF0123456789xyz and password=super-secret
- **Snippet**: \`API_KEY="CANARY"\`
- **Remediation**: Rotate the value
`;

  // Write reports with hyphenated target names and duplicate summary variant
  writeFileSync(path.join(tmpDir, "voicebox-miniapps-perf-review-delta.md"), perfReport, "utf8");
  writeFileSync(path.join(tmpDir, "voicebox-miniapps-perf-review-summary.md"), perfReport, "utf8");
  writeFileSync(path.join(tmpDir, "voicebox-miniapps-secret-scan-delta.md"), secretReport, "utf8");

  const res = formatTriageComment({
    stations: ["perf-review", "secret-scan"],
    findingsDir: tmpDir,
    commitSha: "1e970d595748a7c38b7fd39417e055165d7edecd",
  });
  rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.newFindings, 2);
  assert.ok(Array.isArray(res.comments));
  assert.equal(res.comments.length, 2, "duplicate report variants deduplicated; false positives ignored; 1 comment per finding");

  // Comment 1: perf-review finding (station extracted accurately despite hyphenated target name)
  const c1 = res.comments[0];
  assert.ok(c1.includes("<!-- factory-triage-comment: 5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a -->"));
  assert.ok(c1.includes("<!-- factory-station: perf-review -->"));
  assert.ok(c1.includes("<!-- factory-severity: high -->"));
  assert.ok(c1.includes("<!-- factory-state: new -->"));
  assert.ok(c1.includes("<!-- factory-rule: blocking-boot-probe -->"));
  assert.ok(!c1.includes("<!-- factory-human-review -->"));
  assert.ok(!c1.includes("secret-scan"));
  assert.ok(!c1.includes("FALSE POSITIVE"));

  // Comment 2: secret-scan finding (security station -> human-review flag; candidate withheld; location/rule sanitized)
  const c2 = res.comments[1];
  assert.ok(c2.includes("<!-- factory-triage-comment: a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0 -->"));
  assert.ok(c2.includes("<!-- factory-station: secret-scan -->"));
  assert.ok(c2.includes("<!-- factory-severity: critical -->"));
  assert.ok(c2.includes("<!-- factory-state: new -->"));
  assert.ok(c2.includes("<!-- factory-human-review -->"));
  assert.ok(c2.includes("[withheld: secret-scan finding candidate not published; requires human verification]"));
  assert.ok(!c2.includes("ghp_ABCDEF0123456789xyz"));
  assert.ok(!c2.includes("super-secret"));
  assert.ok(!c2.includes("supersecretkey"));
  assert.ok(!c2.includes("anothersecret"));
  assert.ok(c2.includes("<!-- factory-rule: generic-api-key-with-token -->"));
  assert.ok(c2.includes("config/session.txt"));
  assert.ok(!c2.includes("violetfox"));
  assert.ok(!c2.includes("sid="));
  assert.ok(!c2.includes("anothersecret"));
  assert.ok(!c2.includes("perf-review"));

  // Text sanitization verification
  const dirty = "Exposed Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and token ghp_ABCDEF0123456789xyz and token github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz and api_key='sk_test_123456' and password=my-super-secret-password and api_key=unquoted_secret_val";
  const clean = sanitizeFindingText(dirty);
  assert.ok(!clean.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
  assert.ok(!clean.includes("ghp_ABCDEF0123456789xyz"));
  assert.ok(!clean.includes("github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!clean.includes("sk_test_123456"));
  assert.ok(!clean.includes("my-super-secret-password"));
  assert.ok(!clean.includes("unquoted_secret_val"));
  assert.ok(clean.includes("[REDACTED]"));
});

test("factory-issue-commenter: fingerprint deduplication skips already-commented findings (exitCode 2 no-op) and isolates new sections", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-dedupe-tmp");
  mkdirSync(tmpDir, { recursive: true });

  // Pass 1: One finding
  writeFileSync(
    path.join(tmpDir, "voicebox-perf-review-delta.md"),
    `- [HIGH] perf-review Startup probe blocks boot banner\n  fingerprint: \`5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a\`\n  state: new\n`,
    "utf8"
  );

  const pass1 = formatTriageComment({
    stations: ["perf-review"],
    findingsDir: tmpDir,
    existingComments: [],
  });
  assert.equal(pass1.ok, true);
  assert.equal(pass1.exitCode, 0);
  assert.equal(pass1.newFindings, 1);
  assert.ok(pass1.comment.length > 0);
  assert.ok(pass1.comment.includes("<!-- factory-rule: triaged -->"), "Format B without rule emits fallback factory-rule: triaged");

  // Pass 2: Same finding re-polled with previous comment present -> exitCode 2 (no-op, ZERO duplicate comments)
  const pass2 = formatTriageComment({
    stations: ["perf-review"],
    findingsDir: tmpDir,
    existingComments: [pass1.comment],
  });
  assert.equal(pass2.ok, true);
  assert.equal(pass2.exitCode, 2, "exitCode 2 indicates no-op (nothing new to post)");
  assert.equal(pass2.newFindings, 0);
  assert.equal(pass2.comment, "");

  // Pass 3: Mutated report adds a second finding -> returns comment with ONLY the new finding section
  writeFileSync(
    path.join(tmpDir, "voicebox-perf-review-delta.md"),
    `- [HIGH] perf-review Startup probe blocks boot banner\n  fingerprint: \`5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a\`\n  state: new\n- [MEDIUM] perf-review Large uncompressed texture asset\n  fingerprint: \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`\n  state: new\n`,
    "utf8"
  );

  const pass3 = formatTriageComment({
    stations: ["perf-review"],
    findingsDir: tmpDir,
    existingComments: [pass1.comment],
  });
  rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(pass3.ok, true);
  assert.equal(pass3.exitCode, 0);
  assert.equal(pass3.newFindings, 1, "only the single newly discovered finding is returned");
  assert.equal(pass3.totalFindings, 2);
  assert.ok(pass3.comment.includes("Large uncompressed texture asset"));
  assert.ok(pass3.comment.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  // Does NOT re-emit the old finding description in the new comment items list
  assert.ok(!pass3.comment.includes("Startup probe blocks boot banner"));
});

test("factory-review-trigger: CLI executes cleanly in dry-run mode with deterministic station selection", () => {
  const result = runReviewTrigger(["--base", "HEAD~1", "--tip", "HEAD", "--dry-run"], { rootDir: ROOT });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.station, "selected a station");
  assert.ok(result.cacheKey, "computed a cacheKey");
});

test("factory-review-trigger: parsePublisherSummary extracts anchored counts and sanitized issue URLs", () => {
  const dirtyOutput = [
    "[factory-triage] Beginning triage run...",
    "published: 2",
    "duplicate: 1",
    "actionable: 3",
    "issues: 1 published, 0 duplicate, 1 skipped",
    "skipped: 5939431590a57344 (identity mismatch: unchanged)",
    "skipped: 8a1d534b804960d9 (identity unverifiable: rule heading (reduced/step-summary form))",
    "published: 5939431590a57344 -> https://github.com/PaulKinlan/voicebox/issues/42",
    "published: 2 with unanchored text and token github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz",
    "raw finding details: password=super-secret-password-val and token github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz",
    "internal debug stack trace line",
  ].join("\n");

  const safe = parsePublisherSummary(dirtyOutput);
  // [factory-triage] and unanchored text are omitted; strictly anchored counts and issue URLs survive
  assert.ok(!safe.includes("[factory-triage]"));
  assert.ok(safe.includes("published: 2"));
  assert.ok(safe.includes("duplicate: 1"));
  assert.ok(safe.includes("actionable: 3"));
  assert.ok(safe.includes("issues: 1 published, 0 duplicate, 1 skipped"));
  assert.ok(safe.includes("skipped: 5939431590a57344 (identity mismatch: unchanged)"));
  assert.ok(safe.includes("skipped: 8a1d534b804960d9 (identity unverifiable: rule heading (reduced/step-summary form))"));
  assert.ok(safe.includes("https://github.com/PaulKinlan/voicebox/issues/42"));
  assert.ok(!safe.includes("super-secret-password-val"));
  assert.ok(!safe.includes("github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!safe.includes("with unanchored text"));
  assert.ok(!safe.includes("internal debug stack trace"));
});

test("factory-review-trigger: sanitizeLogOutput masks stderr and issue titles containing secrets and PATs", () => {
  const rawStderr = "Error: authentication failed for github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz with password=super-secret";
  const sanitizedStderr = sanitizeLogOutput(rawStderr);
  assert.ok(!sanitizedStderr.includes("github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!sanitizedStderr.includes("super-secret"));
  assert.ok(sanitizedStderr.includes("[REDACTED]"));

  const rawTitle = "Issue in login with token github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz and secret=topsecret";
  const sanitizedTitle = sanitizeLogOutput(rawTitle);
  assert.ok(!sanitizedTitle.includes("github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!sanitizedTitle.includes("topsecret"));
  assert.ok(sanitizedTitle.includes("[REDACTED]"));
});

test("factory-issue-poller: dry-run does not mutate cursor or attempt directory and makes zero gh calls", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-dryrun-tmp");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const mockBinDir = path.join(tmpDir, "bin");
  mkdirSync(mockBinDir, { recursive: true });
  const mockGh = path.join(mockBinDir, "gh");
  const sentinel = path.join(tmpDir, "gh-called.sentinel");
  // If gh is executed, it touches the sentinel file
  writeFileSync(mockGh, `#!/bin/sh\ntouch "${sentinel}"\necho '[]'\n`, { mode: 0o755 });

  const sampleIssues = [
    {
      number: 101,
      title: "[factory/high] already published loop hazard finding",
      body: "<!-- factory-fingerprint: 1234567890abcdef -->",
      authorAssociation: "COLLABORATOR",
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z",
    },
    {
      number: 102,
      title: "Bug: slow boot with token github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz",
      body: "Investigate boot latency in client",
      authorAssociation: "COLLABORATOR",
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z",
    },
  ];

  // 1. Dry run without injected issues: returns immediately with zero gh calls
  const resultCli = pollInboundIssues(["--dry-run", "--limit", "2", "--private-dir", tmpDir], {
    env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
    rootDir: ROOT,
  });
  assert.equal(existsSync(sentinel), false, "CLI dry run must make zero gh calls");
  assert.equal(resultCli.ok, true);
  assert.equal(resultCli.dryRun, true);

  // 2. Dry run with injected issues: evaluates issues without calling gh or mutating cursor/fs
  const resultInjected = pollInboundIssues(["--dry-run", "--limit", "2", "--private-dir", tmpDir], {
    env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
    rootDir: ROOT,
    issues: sampleIssues,
  });

  const cursorFile = path.join(tmpDir, "factory-issue-cursor.json");
  const issueRunDir = path.join(tmpDir, "issue-102");

  assert.equal(existsSync(sentinel), false, "evaluating injected issues in dry run must make zero gh calls");
  assert.equal(existsSync(cursorFile), false, "dry run must not write cursorFile");
  assert.equal(existsSync(issueRunDir), false, "dry run must not create attempt directory");
  assert.equal(resultInjected.ok, true);
  assert.equal(resultInjected.exitCode, 0);
  assert.deepEqual(resultInjected.cursor.processedIssues, {}, "dry run must not mutate in-memory cursor");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("factory-review-trigger: getCheckoutRepoIdentity resolves normalized repository slug and refuses cross-target publication", () => {
  const repoId = getCheckoutRepoIdentity(ROOT);
  assert.equal(repoId, "paulkinlan/voicebox");

  // Same-slug on foreign/unapproved host is rejected (returns empty string)
  const mockForeignDir = path.join(tmpdir(), `test-foreign-origin-${Math.random().toString(36).slice(2)}`);
  rmSync(mockForeignDir, { recursive: true, force: true });
  mkdirSync(mockForeignDir, { recursive: true });
  const cleanGitEnv = { ...process.env };
  delete cleanGitEnv.GIT_DIR;
  delete cleanGitEnv.GIT_WORK_TREE;
  delete cleanGitEnv.GIT_INDEX_FILE;
  try {
    execFileSync("git", ["init"], { cwd: mockForeignDir, env: cleanGitEnv });
    execFileSync("git", ["remote", "add", "origin", "https://evil.example/PaulKinlan/voicebox.git"], { cwd: mockForeignDir, env: cleanGitEnv });
    const evilId = getCheckoutRepoIdentity(mockForeignDir);
    assert.equal(evilId, "", "unapproved git host must not be treated as proof of repo identity");
  } finally {
    rmSync(mockForeignDir, { recursive: true, force: true });
  }

  // Mismatched target repo is refused before cache lookup with exitCode 1
  const mismatchedRes = runReviewTrigger(["--base", "HEAD~1", "--tip", "HEAD", "--repo", "ForeignOrg/foreign-repo"], {
    rootDir: ROOT,
  });
  assert.equal(mismatchedRes.ok, false);
  assert.equal(mismatchedRes.exitCode, 1);
  assert.ok(mismatchedRes.error.includes("does not match target repo"));
});

test("factory-review-trigger: ambient poisoned GIT_DIR does not blind diff measurement (C2 / GH #19)", (t) => {
  // Negative control / regression (voicebox-beads-nqrl, GH #30): with ambient GIT_DIR pointing at a foreign
  // repository, git merge-base and git diff must still evaluate against the target rootDir via
  // lib/git-env.mjs - never against the foreign repo, and never against whatever the ambient checkout
  // happens to be.
  //
  // This test used to run against ROOT and read ~/agents/.git. That made it assert something about the LIVE
  // checkout: it only passed while HEAD differed from origin/main, and it returned early on any machine
  // without that path - so it failed whenever a tree was gated at main's own tip and proved nothing
  // elsewhere. The measurement is now a property of a fixture this test owns: the diff is fixed by the
  // fixture's two commits and the poisoned GIT_DIR points at a foreign repo the fixture also owns, so the
  // result no longer depends on the checkout's position or on the invoking home directory at all.
  const ownedDirs = new Set();
  t.after(() => {
    for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true });
  });
  const ownDir = (dir) => {
    ownedDirs.add(dir);
    return dir;
  };

  const fixtureRoot = ownDir(mkdtempSync(path.join(tmpdir(), "review-trigger-fixture-")));
  const repoDir = path.join(fixtureRoot, "repo");
  const foreignDir = path.join(fixtureRoot, "foreign");
  const gitHome = path.join(fixtureRoot, "githome");
  const emptyHooks = path.join(fixtureRoot, "empty-hooks");
  for (const dir of [repoDir, foreignDir, gitHome, emptyHooks]) mkdirSync(dir, { recursive: true });

  // Same discipline as the watcher fixture in this file, for the same reason: a test that shells out to git
  // must not inherit the surrounding repository's environment. The pre-push hook exports GIT_DIR, and an
  // inheriting fixture has operated on the surrounding repo before (voicebox-beads-guu9). Absolute trusted
  // git, no PATH, owned HOME/XDG, system/global config and hooks pinned to owned empty locations.
  const trustedGit = "/usr/bin/git";
  accessSync(trustedGit, constants.X_OK);
  const fixtureEnv = {
    HOME: gitHome,
    XDG_CONFIG_HOME: path.join(gitHome, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
  const git = (args, cwd) => execFileSync(
    trustedGit,
    [
      "-c", `core.hooksPath=${emptyHooks}`,
      "-c", `init.templateDir=${emptyHooks}`,
      "-c", "user.email=review-trigger-fixture@test.local",
      "-c", "user.name=review trigger fixture",
      ...args,
    ],
    { cwd, encoding: "utf8", env: fixtureEnv },
  );

  git(["init", "-q", "-b", "main", repoDir], fixtureRoot);
  git(["init", "-q", "-b", "main", foreignDir], fixtureRoot);
  // No remote is configured on purpose: getCheckoutRepoIdentity then returns an empty identity, which the
  // cross-target refusal accepts, so this test measures the diff and not the repository slug (that check has
  // its own test above) and cannot be broken by a change to the expected slug.
  // Fail closed before any write: prove which repo these calls address.
  assert.equal(
    realpathSync(git(["rev-parse", "--show-toplevel"], repoDir).trim()),
    realpathSync(repoDir),
    "fixture git ops must resolve to the fixture itself, not to a surrounding repository",
  );

  // The fixture's diff, fixed by construction: a base commit and two ops-category changes on top.
  writeFileSync(path.join(repoDir, "README.md"), "fixture base\n");
  git(["add", "README.md"], repoDir);
  git(["commit", "-q", "-m", "fixture base"], repoDir);
  const baseSha = git(["rev-parse", "HEAD"], repoDir).trim();
  writeFileSync(path.join(repoDir, "ops-change.log"), "2026-01-01 INFO fixture ops change\n");
  git(["add", "ops-change.log"], repoDir);
  git(["commit", "-q", "-m", "fixture ops change"], repoDir);
  writeFileSync(path.join(repoDir, "ops-second.log"), "2026-01-02 INFO second fixture ops change\n");
  git(["add", "ops-second.log"], repoDir);
  git(["commit", "-q", "-m", "fixture second ops change"], repoDir);
  const tipSha = git(["rev-parse", "HEAD"], repoDir).trim();
  assert.notEqual(baseSha, tipSha, "the fixture must have a real diff for the measurement to find");
  // Two commits above the base on purpose: origin/main points at the base, so the default base (merge-base
  // with origin/main) and the HEAD~1 fallback are different commits, and the trigger's own log line - two
  // changed files rather than one - shows which of the two it actually resolved. With a single commit they
  // coincide and the test could not tell whether the default path ran at all.

  // No --base on purpose. The default path is the one that failed on main's own tip: the trigger resolves
  // `merge-base origin/main HEAD` for itself. So the fixture provides its own origin/main (pointing at the
  // base commit) and the test exercises that resolution rather than bypassing it. An owned --private-dir
  // keeps this run out of the invoking home directory: the trigger reads a review cache BEFORE it returns
  // from dry-run, so an ambient ~/.voicebox cache could otherwise answer for the fixture and make this
  // pass or fail for a reason of its own.
  git(["update-ref", "refs/remotes/origin/main", baseSha], repoDir);
  const privateDir = ownDir(path.join(fixtureRoot, "private"));
  mkdirSync(privateDir, { recursive: true });

  // The foreign repository this fixture owns, standing in for the old ~/agents/.git dependency.
  writeFileSync(path.join(foreignDir, "foreign.txt"), "foreign\n");
  git(["add", "foreign.txt"], foreignDir);
  git(["commit", "-q", "-m", "foreign base"], foreignDir);

  const poisonedEnv = {
    ...process.env,
    GIT_DIR: path.join(foreignDir, ".git"),
    GIT_WORK_TREE: foreignDir,
  };

  const res = runReviewTrigger(["--dry-run", "--tip", "HEAD", "--private-dir", privateDir], {
    env: poisonedEnv,
    rootDir: repoDir,
  });

  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  // Verify the station was selected for the fixture's own changes (not blinded with 0 changed files).
  assert.equal(
    res.station !== null,
    true,
    "review station must be selected for the fixture's own diff, not blinded by the poisoned GIT_DIR"
  );
});

test("factory-review-trigger: locateRunDeltaReport strictly enforces runDir provenance", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-provenance-tmp");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const runDir = path.join(tmpDir, "run-12345");
  mkdirSync(runDir, { recursive: true });

  // 1. Ambient report outside runDir
  const ambientDir = path.join(tmpDir, "findings");
  mkdirSync(ambientDir, { recursive: true });
  const targetName = path.basename(ROOT);
  const ambientReport = path.join(ambientDir, `${targetName}-docs-drift-delta.md`);
  writeFileSync(ambientReport, "# Ambient report\n");

  // Provenance check: ambient report alone yields empty string
  const notFound = locateRunDeltaReport(runDir, ROOT, "docs-drift");
  assert.equal(notFound, "", "ambient report in findings/ must not be accepted");

  // 2. Report in runDir is accepted
  const runReport = path.join(runDir, `${targetName}-docs-drift-delta.md`);
  writeFileSync(runReport, "# Attempt report\n");
  const found = locateRunDeltaReport(runDir, ROOT, "docs-drift");
  assert.equal(found, runReport, "report in runDir must be accepted");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("factory-activation: systemd user units, poller runner, and review gate wrappers are valid", () => {
  const servicePath = path.join(ROOT, "config", "systemd", "user", "voicebox-factory-issue-poller.service");
  const timerPath = path.join(ROOT, "config", "systemd", "user", "voicebox-factory-issue-poller.timer");
  const pollerRunnerPath = path.join(ROOT, "scripts", "factory-issue-poller-runner.sh");
  const reviewGatePath = path.join(ROOT, "scripts", "factory-review-gate.sh");
  const nightlyPublisherPath = path.join(ROOT, "scripts", "factory-nightly-publisher.sh");

  // 1. Files exist and have valid permissions/syntax
  assert.ok(existsSync(servicePath), "systemd service unit exists");
  assert.ok(existsSync(timerPath), "systemd timer unit exists");
  assert.ok(existsSync(pollerRunnerPath), "poller runner script exists");
  assert.ok(existsSync(reviewGatePath), "review gate script exists");
  assert.ok(existsSync(nightlyPublisherPath), "nightly publisher script exists");

  const serviceContent = readFileSync(servicePath, "utf8");
  assert.ok(serviceContent.includes("[Unit]"));
  assert.ok(serviceContent.includes("[Service]"));
  assert.ok(serviceContent.includes("Type=oneshot"));
  assert.ok(serviceContent.includes("factory-issue-poller-runner.sh"));

  const timerContent = readFileSync(timerPath, "utf8");
  assert.ok(timerContent.includes("[Timer]"));
  assert.ok(timerContent.includes("OnCalendar=hourly"));
  assert.ok(timerContent.includes("Persistent=true"));
  assert.ok(timerContent.includes("WantedBy=timers.target"));

  // 2. Review gate, poller runner, and nightly publisher scripts respond to --help
  const gateHelp = execFileSync("bash", [reviewGatePath, "--help"], { encoding: "utf8" });
  assert.ok(gateHelp.includes("Usage: scripts/factory-review-gate.sh"));
  assert.ok(gateHelp.includes("--base"));

  const nightlyHelp = execFileSync("bash", [nightlyPublisherPath, "--help"], { encoding: "utf8" });
  assert.ok(nightlyHelp.includes("Usage: scripts/factory-nightly-publisher.sh"));
  assert.ok(nightlyHelp.includes("--dry-run"));

  // 3. Review trigger and poller scripts respond to --help
  const triggerRes = runReviewTrigger(["--help"], { rootDir: ROOT });
  assert.equal(triggerRes.ok, true);
  assert.equal(triggerRes.help, true);

  const pollerRes = pollInboundIssues(["--help"], { rootDir: ROOT });
  assert.equal(pollerRes.ok, true);
  assert.equal(pollerRes.help, true);

  const watcherRes = runReviewWatcher(["--help"], { rootDir: ROOT });
  assert.equal(watcherRes.ok, true);
  assert.equal(watcherRes.help, true);
});

test("factory-review-adapter: automation diffs (scripts/factory-*, tools/factory-*, config/systemd/*) map to security domain", () => {
  const diff = [
    "scripts/factory-review-trigger.mjs",
    "tools/factory-issue-router.mjs",
    "config/systemd/user/voicebox-factory-issue-poller.service",
  ];
  const sel = selectReviewStation(diff);
  assert.equal(sel.station, "secret-scan");
  assert.equal(sel.category, "security");
});

test("factory-review-watcher: discovers candidate branches matching conjunctive ownership predicate (voicebox-* bead AND fleet/* branch)", () => {
  const mockBeads = [
    {
      id: "bead-1",
      assignee: "voicebox-miniapps",
      status: "in_progress",
      title: "Feature work on fleet/miniapps-test",
      description: "Working on fleet/miniapps-test candidate branch",
    },
    {
      id: "bead-2",
      assignee: "other-lane",
      status: "in_progress",
      title: "Foreign task on fleet/other",
      description: "Not owned by voicebox fleet",
    },
    {
      id: "bead-3",
      assignee: "voicebox-coord",
      status: "in_progress",
      title: "Rescue task on fleet/rescued-1234",
      description: "Merger rescue artifact ref",
    },
  ];

  const tmpPrivate = path.join(ROOT, "tests", "fixtures", "watcher-test-private");
  rmSync(tmpPrivate, { recursive: true, force: true });
  mkdirSync(tmpPrivate, { recursive: true });

  const res = runReviewWatcher(["--dry-run", "--private-dir", tmpPrivate], {
    rootDir: ROOT,
    mockBeads,
  });

  // Only bead-1 has voicebox-* assignee AND non-artifact fleet/* branch
  assert.equal(res.ok, true);
  assert.equal(res.watcherErrors, 0);

  rmSync(tmpPrivate, { recursive: true, force: true });
});

test("factory-review-watcher: auto-publication default, cursor recording, and second-tick deduplication", (t) => {
  // voicebox-beads-7nto / GH #29: this fixture owns directories in /tmp and under tests/fixtures, and its
  // cleanup used to sit at the very bottom of the test - so an assertion failure part way through left the
  // bare origin, the work clone and the private cursor dirs behind. The cleanup is registered with t.after
  // BEFORE the first directory is created, so it runs on pass AND on fail, including a failure during
  // fixture setup. t.after is already the idiom in this suite (acp-browser, acp-console-ui, activity-log).
  // Nothing about the fixture's own guards changes: the trusted-git pin, the owned env, the fixture-root
  // assertion and the push-target assertion all still run, and the cursor, dry-run and fail-closed
  // assertions below are untouched.
  const ownedDirs = new Set();
  t.after(() => {
    for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true });
  });
  const ownDir = (dir) => {
    ownedDirs.add(dir);
    return dir;
  };

  const tmpPrivate = ownDir(path.join(ROOT, "tests", "fixtures", "watcher-dedupe-test"));
  rmSync(tmpPrivate, { recursive: true, force: true });
  mkdirSync(tmpPrivate, { recursive: true });

  const mockBeads = [
    {
      id: "voicebox-beads-test",
      assignee: "voicebox-miniapps",
      status: "in_progress",
      title: "Test task on fleet/watcher-fixture-candidate",
      description: "Working on fleet/watcher-fixture-candidate candidate branch",
    },
  ];

  // Deterministic candidate ref OWNED BY THIS TEST, built as a REAL isolated remote
  // (voicebox-beads-guu9). Two earlier shapes could not work: reading the author's remote-tracking ref
  // depended on the state of the world (that branch landed and was pruned), and creating a ref under
  // refs/remotes/origin/ ourselves does not survive the watcher's own `git fetch origin --prune`, which
  // deletes any tracking ref the remote does not have before the ref is ever read. So the fixture stands
  // up its own bare origin, pushes main and the candidate branch to it, and points the watcher at a clone
  // of it: the prune then PRESERVES the candidate, and rev-parse/merge-base/diff run against real Git.
  // Nothing here touches the shared origin or any author ref.
  const fixtureBranch = "fleet/watcher-fixture-candidate";
  // OUTSIDE the repo tree on purpose: an in-tree fixture that creates a nested repo can end up
  // committing into the surrounding worktree (it did, once, and added a junk commit to the branch).
  const fixtureRoot = ownDir(mkdtempSync(path.join(tmpdir(), "watcher-fixture-remote-")));
  rmSync(fixtureRoot, { recursive: true, force: true });
  const bareDir = path.join(fixtureRoot, "origin.git");
  const workDir = path.join(fixtureRoot, "work");
  mkdirSync(fixtureRoot, { recursive: true });
  // Owned, disposable HOME/XDG for git so no ~/.gitconfig, ~/.config/git/config, or XDG config from the
  // invoking environment can steer the fixture (voicebox-beads-guu9). A hostile global/system config can
  // redirect remote.origin.pushurl or point core.hooksPath at an external hook tree; the allowlist below
  // makes both impossible by pinning system/global config and attributes to /dev/null and blanking hooks.
  const gitHome = path.join(fixtureRoot, "githome");
  const gitXdg = path.join(gitHome, ".config");
  const gitHooksDir = path.join(fixtureRoot, "empty-hooks");
  mkdirSync(gitHome, { recursive: true });
  mkdirSync(gitXdg, { recursive: true });
  mkdirSync(gitHooksDir, { recursive: true });
  // Trusted absolute system Git pinned to /usr/bin/git ONLY. Fail closed with a descriptive error if it
  // is missing or non-executable; NEVER fall back to /usr/local/bin or inherited PATH (voicebox-beads-guu9).
  const TRUSTED_GIT = "/usr/bin/git";
  const resolveTrustedGit = () => {
    try {
      accessSync(TRUSTED_GIT, constants.X_OK);
      return TRUSTED_GIT;
    } catch {
      throw new Error(
        `guu9 fixture security refusal: trusted git executable ${TRUSTED_GIT} is missing or not executable. Refusing to fall back to PATH.`
      );
    }
  };
  const trustedGit = resolveTrustedGit();
  // Freshly constructed allowlisted env: git's HOME/XDG owned by this fixture.
  // NOTHING is inherited from process.env, including PATH (absolute trustedGit is invoked directly),
  // so no GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE can reach the surrounding repo and no
  // GIT_CONFIG_*/GIT_ATTR_* steering variable or hostile PATH can leak in. The only GIT_*
  // entries present are the fixed safe overrides below (system/global config and attributes off; no
  // GIT_CONFIG_COUNT/KEY/VALUE survives).
  const fixtureGitEnv = () => ({
    HOME: gitHome,
    XDG_CONFIG_HOME: gitXdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  });
  // External hooks disabled per call: core.hooksPath points at an owned EMPTY dir and init.templateDir is
  // an owned empty dir, so neither a configured hook nor an init template can run (voicebox-beads-guu9).
  const git = (args, cwd) => execFileSync(
    trustedGit,
    ["-c", `core.hooksPath=${gitHooksDir}`, "-c", `init.templateDir=${gitHooksDir}`, ...args],
    { cwd, encoding: "utf8", env: fixtureGitEnv() },
  );
  git(["init", "--bare", "-q", bareDir], fixtureRoot);
  git(["init", "-q", "-b", "main", workDir], fixtureRoot);
  // FAIL CLOSED, before any config/add/commit/remote: prove which repo these calls address. If the git
  // root is not the fixture itself, the surrounding repo is in reach and this test must abort.
  const fixtureGitRoot = git(["rev-parse", "--show-toplevel"], workDir).trim();
  assert.equal(realpathSync(fixtureGitRoot), realpathSync(workDir),
    `fixture git ops must resolve to the fixture itself, not a parent repo (got ${fixtureGitRoot})`);
  git(["config", "user.email", "watcher-fixture@test.local"], workDir);
  git(["config", "user.name", "watcher fixture"], workDir);
  writeFileSync(path.join(workDir, "README.md"), "watcher fixture base\n");
  git(["add", "README.md"], workDir);
  git(["commit", "-q", "-m", "fixture base"], workDir);
  git(["remote", "add", "origin", bareDir], workDir);
  // Pin the push destination and fail closed on any redirect before EACH push: the effective --push
  // origin URL must be exactly the single owned bareDir, never a config-injected pushurl (voicebox-beads-guu9).
  git(["config", "remote.origin.pushurl", bareDir], workDir);
  const assertPushTarget = () => {
    const got = git(["remote", "get-url", "--push", "--all", "origin"], workDir).trim();
    assert.equal(got, bareDir, `fixture push target must be the owned bare repo (got ${got})`);
  };
  assertPushTarget();
  git(["push", "-q", "origin", "main"], workDir);
  assert.equal(git(["rev-parse", "refs/heads/main"], bareDir).trim(),
    git(["rev-parse", "HEAD"], workDir).trim(),
    "bare origin main must resolve the pushed commit");
  git(["checkout", "-q", "-b", fixtureBranch], workDir);
  writeFileSync(path.join(workDir, "candidate.txt"), "candidate change\n");
  git(["add", "candidate.txt"], workDir);
  git(["commit", "-q", "-m", "fixture candidate"], workDir);
  assertPushTarget();
  git(["push", "-q", "origin", `${fixtureBranch}:refs/heads/${fixtureBranch}`], workDir);
  assert.equal(git(["rev-parse", `refs/heads/${fixtureBranch}`], bareDir).trim(),
    git(["rev-parse", "HEAD"], workDir).trim(),
    "bare origin candidate ref must resolve the pushed commit");
  git(["fetch", "-q", "origin", "--prune"], workDir);
  const tipSha = git(["rev-parse", `refs/remotes/origin/${fixtureBranch}`], workDir).trim();
  const taskKey = `${fixtureBranch}@${tipSha}`;
  const cursorFile = path.join(tmpPrivate, "review-watcher-cursor.json");

  let triggerInvocations = [];
  const trackingTrigger = (triggerArgs, opts) => {
    triggerInvocations.push({ triggerArgs, opts });
    return { ok: true, exitCode: 0, station: "secret-scan", verdict: "PASS" };
  };

  // 1. Tick 1 with NO flags (defaults only): must invoke trigger with auto-publication (no --dry-run)
  const res1 = runReviewWatcher(["--private-dir", tmpPrivate], {
    rootDir: workDir,
    mockBeads,
    triggerRunner: trackingTrigger,
  });

  assert.equal(res1.ok, true);
  assert.equal(res1.scannedCount, 1);
  assert.equal(triggerInvocations.length, 1);
  assert.equal(
    triggerInvocations[0].triggerArgs.includes("--dry-run"),
    false,
    "watcher must NOT pass --dry-run by default (auto-publication must be enabled by default)"
  );

  // Assert cursor file was ACTUALLY created and populated by runReviewWatcher
  assert.equal(existsSync(cursorFile), true, "cursor file must exist after tick 1");
  const cursorContent = JSON.parse(readFileSync(cursorFile, "utf8"));
  assert.ok(cursorContent.processedBranches[taskKey], "cursor must record taskKey after successful scan");
  assert.equal(cursorContent.processedBranches[taskKey].station, "secret-scan");
  assert.equal(cursorContent.processedBranches[taskKey].verdict, "PASS");

  // 2. Tick 2: Second invocation on the same branch must detect cursor entry and DEDUPLICATE (zero trigger calls)
  triggerInvocations = [];
  const res2 = runReviewWatcher(["--private-dir", tmpPrivate], {
    rootDir: workDir,
    mockBeads,
    triggerRunner: trackingTrigger,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.scannedCount, 0, "second tick must deduplicate and skip already-processed branch");
  assert.equal(triggerInvocations.length, 0, "trigger must NOT be invoked on second tick (deduped)");

  // 3. Failure negative control: when trigger fails, watcher fails closed and does NOT write cursor
  const tmpFailPrivate = ownDir(path.join(ROOT, "tests", "fixtures", "watcher-fail-test"));
  rmSync(tmpFailPrivate, { recursive: true, force: true });
  mkdirSync(tmpFailPrivate, { recursive: true });

  const failingTrigger = () => {
    return { ok: false, exitCode: 1 };
  };

  // NOTE: this control must run against the SAME isolated clone (workDir), not ROOT. Against ROOT the
  // fixture candidate ref does not exist, so the watcher skips the candidate, the failing trigger is never
  // invoked, and the control reads as a pass for the wrong reason (voicebox-beads-guu9).
  const resFail = runReviewWatcher(["--private-dir", tmpFailPrivate], {
    rootDir: workDir,
    mockBeads,
    triggerRunner: failingTrigger,
  });
  assert.equal(resFail.ok, false, "watcher must fail closed when trigger fails");
  assert.equal(resFail.watcherErrors, 1);

  const failCursorFile = path.join(tmpFailPrivate, "review-watcher-cursor.json");
  if (existsSync(failCursorFile)) {
    const failCursorContent = JSON.parse(readFileSync(failCursorFile, "utf8"));
    assert.equal(
      Boolean(failCursorContent.processedBranches?.[taskKey]),
      false,
      "failed scan must not be recorded in cursor"
    );
  }

  // Cleanup is owned by the t.after hook registered at the top of this test (voicebox-beads-7nto), so it
  // runs whether the assertions above pass or fail.
});

test("factory-nightly-publisher: enforces SAME-RUN manifest barrier, target check, and batch window", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "nightly-pub-tmp");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const findingsDir = path.join(tmpDir, "findings");
  const runsDir = path.join(tmpDir, "runs");
  const privateDir = path.join(tmpDir, "private");
  mkdirSync(findingsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });

  // Negative Control 1: Missing manifest -> fails closed
  const resMissing = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.error, "missing_manifest");

  // Negative Control 2: Foreign target manifest -> fails closed
  const foreignManifest = {
    target: "foreign-repo",
    line: "project-audit",
    complete: true,
    generated: new Date().toISOString(),
    stations: [{ station: "secret-scan", status: "PASS", run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(foreignManifest));
  const resForeign = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resForeign.ok, false);
  assert.equal(resForeign.error, "foreign_manifest_target");

  // Negative Control 3: Incomplete or failed station manifest -> fails closed
  const failedManifest = {
    target: "voicebox-factory",
    line: "project-audit",
    complete: true,
    generated: new Date().toISOString(),
    stations: [{ station: "secret-scan", status: "FAIL", run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(failedManifest));
  const resFailed = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resFailed.ok, false);
  assert.equal(resFailed.error, "failed_stations");

  // Positive Control: Valid all-PASS manifest with matching delta report -> succeeds
  const now = new Date();
  const validManifest = {
    target: "voicebox-factory",
    line: "project-audit",
    complete: true,
    generated: now.toISOString(),
    stations: [{ station: "secret-scan", status: "PASS", findings_count: 0, criticals: 0, run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(validManifest));

  const validReport = `# Software Factory Delta Report: voicebox-factory / secret-scan
Generated: ${now.toISOString()}

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **0** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

None.
`;
  writeFileSync(path.join(findingsDir, "voicebox-factory-secret-scan-delta.md"), validReport);

  const resValid = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resValid.ok, true);
  assert.equal(resValid.processedCount, 1);

  // Idempotent duplicate check: second invocation with real cursor skips batch
  const cursorFile = path.join(privateDir, "nightly-cursor.json");
  writeFileSync(cursorFile, JSON.stringify({ lastPublishedBatch: validManifest.generated }));
  const resDup = publishNightlyFindings([
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resDup.ok, true);
  assert.equal(resDup.skippedDuplicate, true);

  // Negative Control 4: Manifest station declares findings_count=5, criticals=1 but report is missing -> fails closed!
  const missingReportManifest = {
    target: "voicebox-factory",
    line: "project-audit",
    complete: true,
    generated: new Date().toISOString(),
    stations: [{ station: "deps-supply-chain", status: "PASS", findings_count: 5, criticals: 1, run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(missingReportManifest));
  rmSync(cursorFile, { force: true });

  const resMissingReport = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resMissingReport.ok, false, "must fail closed when declared findings lack delta report");
  assert.equal(resMissingReport.exitCode, 1);
  assert.equal(existsSync(cursorFile), false, "cursor must NOT advance on missing report");

  // Positive Control 2: Manifest station declares findings_count=0, criticals=0 with no delta report -> succeeds as clean pass
  const cleanPassManifest = {
    target: "voicebox-factory",
    line: "project-audit",
    complete: true,
    generated: new Date().toISOString(),
    stations: [{ station: "qa-station", status: "PASS", findings_count: 0, criticals: 0, run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(cleanPassManifest));
  const resCleanPass = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resCleanPass.ok, true, "explicit findings_count=0 allows absent delta report");

  // Negative Control 5: Station report with SKIPPED findings (e.g. fingerprint identity mismatch) fails closed (exit 1, cursor unchanged)
  const skippedFindingReport = `# Software Factory Delta Report: voicebox-factory / secret-scan
Generated: ${new Date().toISOString()}

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [CRITICAL] Synthetic mismatched finding (\`new\`)
- **Rule**: \`synthetic-rule\`
- **Location**: \`tests/fixture.txt:10\`
- **Fingerprint**: \`11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff\`
- **Description**: credential found
- **Snippet**: \`TOKEN="test"\`
- **Remediation**: Remove
`;
  writeFileSync(path.join(findingsDir, "voicebox-factory-deps-supply-chain-delta.md"), skippedFindingReport);
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(missingReportManifest));
  rmSync(cursorFile, { force: true });

  const resSkipped = publishNightlyFindings([
    "--dry-run",
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resSkipped.ok, false, "skipped findings must fail closed");
  assert.equal(resSkipped.exitCode, 1);
  assert.equal(existsSync(cursorFile), false, "cursor must NOT advance on skipped findings");

  // Recovery Control: When a genuinely clean report is provided, retry succeeds and cursor advances
  const cleanReport = `# Software Factory Delta Report: voicebox-factory / deps-supply-chain
Generated: ${new Date().toISOString()}

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **0** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

None.
`;
  writeFileSync(path.join(findingsDir, "voicebox-factory-deps-supply-chain-delta.md"), cleanReport);
  const cleanReportManifest = {
    target: "voicebox-factory",
    line: "project-audit",
    complete: true,
    generated: new Date().toISOString(),
    stations: [{ station: "deps-supply-chain", status: "PASS", findings_count: 0, criticals: 0, run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(cleanReportManifest));

  const resRecovered = publishNightlyFindings([
    "--findings-dir", findingsDir,
    "--runs-dir", runsDir,
    "--private-dir", privateDir,
  ], { rootDir: ROOT });
  assert.equal(resRecovered.ok, true, "retry succeeds when clean report appears");
  assert.equal(existsSync(cursorFile), true, "cursor advances on complete successful batch");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("factory-review-trigger: validateStationReportProvenance verifies target, station, freshness, and hash delta", async () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-val-prov-tmp");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const reportPath = path.join(tmpDir, "report.md");
  const startTime = Date.now();
  const targetName = "voicebox-miniapps";
  const station = "secret-scan";

  // 1. Missing report
  const resMissing = validateStationReportProvenance(path.join(tmpDir, "nonexistent.md"), { targetName, station, startTime, rootDir: ROOT });
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.error, "report_not_found");

  // 2. Empty report
  writeFileSync(reportPath, "   \n");
  const resEmpty = validateStationReportProvenance(reportPath, { targetName, station, startTime, rootDir: ROOT });
  assert.equal(resEmpty.ok, false);
  assert.equal(resEmpty.error, "report_empty");

  // 3. Unchanged content hash
  const staticContent = `# Software Factory Delta Report: voicebox-miniapps / secret-scan\nGenerated: ${new Date(startTime + 1000).toISOString()}\n\n| New | 0 |\n`;
  writeFileSync(reportPath, staticContent);
  const realHash = (await import("node:crypto")).createHash("sha256").update(staticContent).digest("hex");
  const resUnchanged = validateStationReportProvenance(reportPath, { targetName, station, startTime, hashBefore: realHash, rootDir: ROOT });
  assert.equal(resUnchanged.ok, false);
  assert.equal(resUnchanged.error, "report_unchanged_from_prior_attempt");

  // 4. Missing header
  writeFileSync(reportPath, `Generated: ${new Date(startTime + 1000).toISOString()}\n\nRandom text without header\n`);
  const resNoHeader = validateStationReportProvenance(reportPath, { targetName, station, startTime, rootDir: ROOT });
  assert.equal(resNoHeader.ok, false);
  assert.equal(resNoHeader.error, "missing_factory_delta_header");

  // 5. Target mismatch (foreign target)
  writeFileSync(reportPath, `# Software Factory Delta Report: foreign-target / secret-scan\nGenerated: ${new Date(startTime + 1000).toISOString()}\n`);
  const resTargetMismatch = validateStationReportProvenance(reportPath, { targetName, station, startTime, rootDir: ROOT });
  assert.equal(resTargetMismatch.ok, false);
  assert.ok(resTargetMismatch.error.startsWith("target_mismatch"));

  // 6. Station mismatch (interleaved different station write)
  writeFileSync(reportPath, `# Software Factory Delta Report: voicebox-miniapps / perf-review\nGenerated: ${new Date(startTime + 1000).toISOString()}\n`);
  const resStationMismatch = validateStationReportProvenance(reportPath, { targetName, station: "secret-scan", startTime, rootDir: ROOT });
  assert.equal(resStationMismatch.ok, false);
  assert.ok(resStationMismatch.error.startsWith("station_mismatch"));

  // 7. Stale report timestamp (older than run start)
  writeFileSync(reportPath, `# Software Factory Delta Report: voicebox-miniapps / secret-scan\nGenerated: ${new Date(startTime - 60000).toISOString()}\n`);
  const resStale = validateStationReportProvenance(reportPath, { targetName, station, startTime, rootDir: ROOT });
  assert.equal(resStale.ok, false);
  assert.ok(resStale.error.startsWith("stale_report_timestamp"));

  // 8. Positive control: valid report satisfying all invariants
  writeFileSync(reportPath, `# Software Factory Delta Report: voicebox-miniapps / secret-scan\nGenerated: ${new Date(startTime + 1000).toISOString()}\n\n| New | 0 |\n`);
  const resValid = validateStationReportProvenance(reportPath, { targetName, station, startTime, rootDir: ROOT });
  assert.equal(resValid.ok, true);
  assert.ok(resValid.hash);

  rmSync(tmpDir, { recursive: true, force: true });
});

test("factory-review-trigger: focused concurrency negative control rejects interleaved foreign station report", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-concurrency-tmp");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const targetName = path.basename(ROOT);
  const startTime = Date.now();

  // Simulate an interleaved station write where Station A (secret-scan) expected its report,
  // but an interleaved job wrote a perf-review report with stale or mismatched station header
  const interleavedReport = path.join(tmpDir, `${targetName}-secret-scan-delta.md`);
  writeFileSync(interleavedReport, `# Software Factory Delta Report: ${targetName} / perf-review\nGenerated: ${new Date(startTime + 500).toISOString()}\n\n| New | 1 |\n`);

  const provRes = validateStationReportProvenance(interleavedReport, {
    targetName,
    station: "secret-scan",
    startTime,
    rootDir: ROOT,
  });

  // Must fail closed due to station mismatch
  assert.equal(provRes.ok, false);
  assert.ok(provRes.error.includes("station_mismatch"));

  rmSync(tmpDir, { recursive: true, force: true });
});

