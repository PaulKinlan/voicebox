// tests/factory-redaction-surfaces.test.mjs — one token, every public surface that can carry it.
//
// voicebox-beads-7cvr / GH #20. `lib/redact.mjs` owns the credential shapes, and the surfaces that
// publish a finding must all mask the same token. Three surfaces can carry one out of the building:
//
//   * the ISSUE BODY the triage builds (`buildIssue`);
//   * the COMMENT the commenter posts (`sanitizeFindingText`);
//   * the LOG line the review trigger writes (`sanitizeLogOutput`).
//
// Before this test's change, those three disagreed. `lib/redact.mjs` masked only the Google-key and
// sk- families, so a GitLab PAT, an npm token, a Slack token, a `ya29.` token, a stripe key, a JWT or
// an AWS access key reached the comment and log surfaces UNMASKED; and the triage's own table matched
// only `ghp_`-style GitHub tokens, so the rest of the github family (`gho_`, `ghu_`, `ghs_`, `ghr_`)
// reached the body unmasked while the callers' private regex covered it. Two of those disagreements are
// the probes below, chosen because they were red on the tree before this change and green after it:
//
//   * body    — a `gho_` token: the old triage table matched `ghp_` + 36 only.
//   * comment / log — a `glpat-` token: the old shared owner had no GitLab shape at all, and both
//     callers carried a GitHub-only regex of their own.
//
// Every probe is SYNTHETIC: a documented prefix plus a run of one letter, built here from parts. None of
// them is a real credential, and none is a complete token-shaped literal copied from anywhere. The
// assertions require the MASK MARKER to be present as well as the raw token to be absent, so a test that
// passed because the token never reached the surface at all cannot pass here. That distinction is the
// one `--dry-run`-style mistakes taught this repository: absence is not masking.

import test from "node:test";
import assert from "node:assert/strict";
import { buildIssue, routeFinding } from "../scripts/factory-triage.mjs";
import { sanitizeFindingText } from "../tools/factory-issue-commenter.mjs";
import { sanitizeLogOutput } from "../scripts/factory-review-trigger.mjs";
import { BARE_TOKEN_SHAPES } from "../lib/redact.mjs";

const repeat = (char, count) => char.repeat(count);

/** Synthetic sample per owned shape: prefix + filler, never a real credential. */
const SAMPLES = [
  ["pem-block", `-----BEGIN RSA PRIVATE KEY-----\n${repeat("A", 24)}\n-----END RSA PRIVATE KEY-----`],
  ["openai-key", `sk-${repeat("A", 24)}`],
  ["stripe-key", `sk_live_${repeat("A", 24)}`],
  ["google-api-key", `AIza${repeat("A", 30)}`],
  ["google-oauth", `ya29.${repeat("A", 24)}`],
  ["gitlab-pat", `glpat-${repeat("A", 20)}`],
  ["npm-token", `npm_${repeat("A", 36)}`],
  ["aws-access-key", `AKIA${repeat("A", 16)}`],
  ["github-pat", `gho_${repeat("A", 36)}`],
  ["slack-token", `xoxb-${repeat("1", 10)}-${repeat("2", 10)}-${repeat("a", 10)}`],
  ["jwt-token", `ey${repeat("A", 12)}.ey${repeat("B", 12)}.${repeat("C", 12)}`],
];

/** A finding whose text carries `token` in prose, where only a bare shape can catch it. */
const findingFor = (token) => ({
  agent: "perf-review",
  ruleId: "render-blocking-resource",
  path: "public/index.html",
  lineNumber: "31",
  state: "new",
  title: `The scan echoed ${token} while reading the page`,
  description: `The scanner reported ${token} in prose, with no key or label around it`,
  remediation: `Remove ${token} from the deployed page`,
  snippet: `const probe = "${token}";`,
  className: "performance",
  effectiveSeverity: "low",
  severityReported: "low",
  identityCritical: false,
  fingerprint: "3".repeat(64),
  identitySource: "recomputed-and-verified",
});

const marker = (name) => `[redacted:${name}]`;

test("every synthetic probe is actually matched by the shape it is named for", () => {
  const shapes = new Map(BARE_TOKEN_SHAPES);
  for (const [name, sample] of SAMPLES) {
    const pattern = shapes.get(name);
    assert.ok(pattern, `lib/redact.mjs must own the '${name}' shape`);
    pattern.lastIndex = 0;
    assert.ok(pattern.test(sample), `the '${name}' probe must be something that shape matches, or the probe proves nothing`);
  }
});

test("the ISSUE BODY masks every owned shape, and shows that it masked something", () => {
  for (const [name, sample] of SAMPLES) {
    const issue = buildIssue(findingFor(sample), routeFinding(findingFor(sample)), { repo: "owner/voicebox" });
    const published = `${issue.title}\n${issue.body}`;
    assert.ok(!published.includes(sample), `the issue body must not carry the raw ${name} token`);
    assert.ok(
      published.includes(marker(name)),
      `the issue body must show the masked ${name} form, not merely omit the token (absence is not masking)`,
    );
  }
});

test("the COMMENT masks every owned shape, and shows that it masked something", () => {
  for (const [name, sample] of SAMPLES) {
    const text = `Reviewed the finding. The value ${sample} was present in the page.`;
    const sanitized = sanitizeFindingText(text);
    assert.ok(!sanitized.includes(sample), `the posted comment must not carry the raw ${name} token`);
    assert.match(sanitized, /\[redacted\]/i, `the posted comment must show a mask for ${name}`);
  }
});

test("the LOG masks every owned shape, and shows that it masked something", () => {
  for (const [name, sample] of SAMPLES) {
    const line = `[review] station output: ${sample}`;
    const sanitized = sanitizeLogOutput(line);
    assert.ok(!sanitized.includes(sample), `the log line must not carry the raw ${name} token`);
    assert.match(sanitized, /\[redacted\]/i, `the log line must show a mask for ${name}`);
  }
});

// The two probes that were RED before this change, named so the regression cannot be mistaken for a
// description of code that always agreed with itself.
test("the probes that disagreed before the single owner agree now", () => {
  const gitlab = `glpat-${repeat("A", 20)}`;
  const githubOther = `gho_${repeat("A", 36)}`;

  assert.ok(!sanitizeFindingText(`comment ${gitlab}`).includes(gitlab), "comment: gitlab family is the owner's job now");
  assert.ok(!sanitizeLogOutput(`log ${gitlab}`).includes(gitlab), "log: gitlab family is the owner's job now");

  const issue = buildIssue(findingFor(githubOther), routeFinding(findingFor(githubOther)), { repo: "owner/voicebox" });
  assert.ok(!`${issue.title}\n${issue.body}`.includes(githubOther), "body: the whole github family, not only ghp_");
});

// A redactor has two failure directions, and this file has to catch both. The assertions above catch
// UNDER-matching (a token that got out). These catch OVER-matching, which is not the safe direction it
// sounds like: the first version of this change dropped the owner's word-boundary guards, and `sk-`
// matched inside `task-runner`, so the body, the comment and the log all published
// "ta[redacted:openai-key]" - six mangled words in one sentence, in a product whose whole vocabulary is
// task-*. A redactor that rewrites ordinary prose destroys the report it is protecting (reviewer P1).
const ORDINARY_PROSE = [
  "task-runner",
  "task-status",
  "task-action",
  "task-worker",
  "task-deadline",
  "task-cancelled",
  "flask-server",
  "desk-drawer",
  "disk-format",
  "risk-assessment",
];

test("ordinary hyphenated words are not redacted on any surface", () => {
  const sentence = `The ${ORDINARY_PROSE.join(" and ")} all stayed intact.`;
  const surfaces = {
    "issue body": (text) => {
      const finding = { ...findingFor("placeholder"), description: text, title: text, snippet: text };
      const issue = buildIssue(finding, routeFinding(finding), { repo: "owner/voicebox" });
      return `${issue.title}\n${issue.body}`;
    },
    comment: (text) => sanitizeFindingText(text),
    log: (text) => sanitizeLogOutput(text),
  };
  for (const [name, drive] of Object.entries(surfaces)) {
    const published = drive(sentence);
    for (const word of ORDINARY_PROSE) {
      assert.ok(published.includes(word), `the ${name} must leave the ordinary word '${word}' alone`);
    }
    assert.ok(!published.includes("[redacted"), `the ${name} must not redact ordinary prose`);
  }
});
