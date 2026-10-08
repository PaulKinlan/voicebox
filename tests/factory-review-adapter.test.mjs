import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import {
  selectReviewStation,
  computeReviewCacheKey,
  routeIssue,
  PRIORITY_ORDER,
  CATEGORY_STATIONS,
} from "../tools/factory-issue-router.mjs";
import { formatTriageComment, sanitizeFindingText } from "../tools/factory-issue-commenter.mjs";
import { runReviewTrigger, parsePublisherSummary, sanitizeLogOutput, locateRunDeltaReport, getCheckoutRepoIdentity } from "../scripts/factory-review-trigger.mjs";
import { pollInboundIssues } from "../scripts/factory-issue-poller.mjs";

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

  // Case D: Untrusted author (NONE) rejected by author trust gate
  const untrustedIssue = {
    number: 20,
    author_association: "NONE",
    title: "Security vulnerability report",
    body: "Found potential token leak",
  };
  const resD = routeIssue(untrustedIssue);
  assert.equal(resD.ok, false);
  assert.ok(resD.reason.includes("author_association 'NONE' is not in trusted set"));
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

test("factory-review-trigger: getCheckoutRepoIdentity resolves normalized repository slug", () => {
  const repoId = getCheckoutRepoIdentity(ROOT);
  assert.equal(repoId, "paulkinlan/voicebox");
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
