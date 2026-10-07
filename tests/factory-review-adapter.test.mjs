import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import {
  selectReviewStation,
  computeReviewCacheKey,
  routeIssue,
  PRIORITY_ORDER,
  CATEGORY_STATIONS,
} from "../tools/factory-issue-router.mjs";
import { formatTriageComment, sanitizeFindingText } from "../tools/factory-issue-commenter.mjs";
import { runReviewTrigger, parsePublisherSummary } from "../scripts/factory-review-trigger.mjs";
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

test("factory-issue-commenter: embeds all 4 shared markers and sanitizes credentials across all severities", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-report-tmp");
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(
    path.join(tmpDir, "voicebox-perf-review-delta.md"),
    `- [HIGH] perf-review Startup probe blocks boot banner\n  fingerprint: \`5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a\`\n  state: new\n`,
    "utf8"
  );
  writeFileSync(
    path.join(tmpDir, "voicebox-secret-scan-delta.md"),
    `- [CRITICAL] secret-scan Hardcoded API credential in config\n  fingerprint: \`a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0\`\n  state: new\n`,
    "utf8"
  );

  const res = formatTriageComment({
    stations: ["perf-review", "secret-scan"],
    findingsDir: tmpDir,
    commitSha: "1e970d595748a7c38b7fd39417e055165d7edecd",
  });
  rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.newFindings, 2);
  assert.ok(res.comment.includes("Software Factory Automated Triage"));
  assert.ok(res.comment.includes("<!-- factory-triage-comment: 5939431590a573447f5b1826c33d12e4b2429002741349d1d8313deb7af5cd9a -->"));
  assert.ok(res.comment.includes("<!-- factory-station: perf-review -->"));
  assert.ok(res.comment.includes("<!-- factory-severity: high -->"));
  assert.ok(res.comment.includes("<!-- factory-state: new -->"));
  assert.ok(res.comment.includes("<!-- factory-station: secret-scan -->"));
  assert.ok(res.comment.includes("<!-- factory-human-review -->"));

  // Text sanitization verification (including ordinary unquoted credentials and fine-grained PATs)
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

test("factory-review-trigger: parsePublisherSummary extracts safe summary and redacts secrets", () => {
  const dirtyOutput = [
    "[factory-triage] Beginning triage run...",
    "published: 2 with github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz",
    "duplicate: 1 password=super-secret-password-val",
    "actionable: 3",
    "https://github.com/PaulKinlan/voicebox/issues/42",
    "raw finding details: password=super-secret-password-val and token github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz",
    "internal debug stack trace line",
  ].join("\n");

  const safe = parsePublisherSummary(dirtyOutput);
  // [factory-triage] is not an accepted count line; strictly count lines and issue URLs survive
  assert.ok(!safe.includes("[factory-triage]"));
  assert.ok(safe.includes("published: 2 with [REDACTED]"));
  assert.ok(safe.includes("duplicate: 1 password=[redacted]"));
  assert.ok(safe.includes("actionable: 3"));
  assert.ok(safe.includes("https://github.com/PaulKinlan/voicebox/issues/42"));
  assert.ok(!safe.includes("super-secret-password-val"));
  assert.ok(!safe.includes("github_pat_11ABCD1234567890abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!safe.includes("internal debug stack trace"));
});

test("factory-issue-poller: pollInboundIssues processes issues cleanly in dry-run with rmSync isolation", () => {
  const tmpDir = path.join(ROOT, "tests", "fixtures", "test-poller-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const mockBinDir = path.join(tmpDir, "bin");
  mkdirSync(mockBinDir, { recursive: true });
  const mockGh = path.join(mockBinDir, "gh");
  const sampleIssues = [
    {
      number: 101,
      title: "Bug: slow boot",
      body: "Investigate boot latency in client",
      authorAssociation: "COLLABORATOR",
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z",
    },
  ];
  writeFileSync(mockGh, `#!/bin/sh\necho '${JSON.stringify(sampleIssues)}'\n`, { mode: 0o755 });

  const result = pollInboundIssues(["--dry-run", "--limit", "1", "--private-dir", tmpDir], {
    env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
    rootDir: ROOT,
  });
  rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.processedCount, 1);
});
