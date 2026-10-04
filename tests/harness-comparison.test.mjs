// tests/harness-comparison.test.mjs — Unit tests for multi-harness result comparison & diff synthesis.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  extractDiffFiles,
  scoreHarnessRun,
  compareHarnessRuns,
  synthesizeComparison,
} from "../lib/harness-comparison.mjs";
import {
  ID_PATTERNS,
  JARGON,
  identifiersInRenderedText,
} from "../tools/rendered-plain-language.mjs";

const BANNED_JARGON_WORDS = [
  "sandbox",
  "iframe",
  "srcdoc",
  "opfs",
  "ipc",
  "json",
  "rpc",
  "wasm",
  "idempotence",
  "worktree",
];

const BANNED_TICKET_SUBSTRINGS = [
  "3si2",
  "dtjf",
  "8l9g",
  "jagv",
  "75uz",
  "osba",
  "hn7x",
  "lmvn",
  "xgnm",
  "zjdd",
  "keb7",
  "bavl",
  "tjih",
  "2vza",
  "von8",
  "0jxa",
  "sqeh",
  "2meg",
  "3rcy",
];

function scanPlainLanguage(rawHtml) {
  const withoutStyleAndComments = rawHtml
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const hits = [...identifiersInRenderedText(withoutStyleAndComments)];

  for (const [re, label, remedy] of ID_PATTERNS) {
    const m = withoutStyleAndComments.match(re);
    if (m) hits.push({ token: m[0], label, remedy });
  }
  for (const [word, remedy] of JARGON) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(withoutStyleAndComments)) {
      hits.push({ token: word, label: "jargon", remedy });
    }
  }
  for (const word of BANNED_JARGON_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(rawHtml)) {
      hits.push({ token: word, label: "banned-jargon", remedy: "use plain language" });
    }
  }
  for (const id of BANNED_TICKET_SUBSTRINGS) {
    if (rawHtml.toLowerCase().includes(id.toLowerCase())) {
      hits.push({ token: id, label: "ticket-id", remedy: "remove ticket id substring" });
    }
  }
  return hits;
}

test("extractDiffFiles parses unified git diff headers and inline file paths while ignoring /dev/null", () => {
  const patchText = [
    "diff --git a/lib/claude-acp.mjs b/lib/claude-acp.mjs",
    "--- a/lib/claude-acp.mjs",
    "+++ b/lib/claude-acp.mjs",
    "@@ -1,3 +1,4 @@",
    "diff --git a/dev/null b/core/task-card.ts",
    "--- /dev/null",
    "+++ b/core/task-card.ts",
    "Updated tests/claude-acp.test.mjs to verify diagnostics.",
  ].join("\n");

  const files = extractDiffFiles(patchText);
  assert.deepEqual(files, [
    "lib/claude-acp.mjs",
    "core/task-card.ts",
    "tests/claude-acp.test.mjs",
  ]);
  assert.deepEqual(extractDiffFiles(""), []);
});

test("scoreHarnessRun awards points for completion, output, touched files, and faster execution", () => {
  const fastCompleted = scoreHarnessRun({
    id: "run-claude",
    harness: "claude",
    status: "completed",
    durationMs: 1200,
    output: "diff --git a/lib/tasks.mjs b/lib/tasks.mjs\n+++ b/lib/tasks.mjs",
  });

  const slowCompleted = scoreHarnessRun({
    id: "run-pi",
    harness: "pi",
    status: "completed",
    durationMs: 15000,
    output: "diff --git a/lib/tasks.mjs b/lib/tasks.mjs\n+++ b/lib/tasks.mjs",
  });

  const runningRun = scoreHarnessRun({
    id: "run-agy",
    harness: "antigravity",
    status: "running",
    durationMs: 2000,
    output: "Inspecting lib/tasks.mjs",
  });

  const failedRun = scoreHarnessRun({
    id: "run-codex",
    harness: "codex",
    status: "interrupted",
    durationMs: 800,
    output: "Process exited with code 1",
  });

  assert.ok(fastCompleted.score > slowCompleted.score, "faster completed run should score higher");
  assert.ok(slowCompleted.score > runningRun.score, "completed run should score higher than running");
  assert.equal(failedRun.score, 0, "interrupted/failed run should receive score 0");
  assert.deepEqual(fastCompleted.filesTouched, ["lib/tasks.mjs"]);
});

test("compareHarnessRuns and synthesizeComparison rank runs, identify shared/unique files, and support winner override", () => {
  const parallelRuns = [
    {
      id: "task_pi_1",
      agent: "pi",
      status: "completed",
      prompt: "Optimize ACP error diagnostics",
      durationMs: 4200,
      resultSummary: [
        "diff --git a/lib/pi-acp.mjs b/lib/pi-acp.mjs",
        "+++ b/lib/pi-acp.mjs",
        "diff --git a/tests/pi-acp.test.mjs b/tests/pi-acp.test.mjs",
        "+++ b/tests/pi-acp.test.mjs",
      ].join("\n"),
    },
    {
      id: "task_claude_1",
      agent: "claude",
      status: "completed",
      prompt: "Optimize ACP error diagnostics",
      durationMs: 1200,
      resultSummary: [
        "diff --git a/lib/pi-acp.mjs b/lib/pi-acp.mjs",
        "+++ b/lib/pi-acp.mjs",
        "diff --git a/lib/claude-acp.mjs b/lib/claude-acp.mjs",
        "+++ b/lib/claude-acp.mjs",
      ].join("\n"),
    },
    {
      id: "task_agy_1",
      agent: "antigravity",
      status: "running",
      prompt: "Optimize ACP error diagnostics",
      durationMs: 2500,
      resultSummary: "Touching lib/pi-acp.mjs and browser/task-card.ts",
    },
  ];

  const compared = compareHarnessRuns(parallelRuns);
  assert.deepEqual(compared.harnesses, ["pi", "claude", "antigravity"]);
  assert.deepEqual(compared.sharedFiles, ["lib/pi-acp.mjs"]);
  assert.deepEqual(compared.uniqueFilesByHarness.pi, ["tests/pi-acp.test.mjs"]);
  assert.deepEqual(compared.uniqueFilesByHarness.claude, ["lib/claude-acp.mjs"]);
  assert.deepEqual(compared.uniqueFilesByHarness.antigravity, ["browser/task-card.ts"]);

  assert.equal(compared.ranking[0].id, "task_claude_1");
  assert.equal(compared.ranking[1].id, "task_pi_1");
  assert.equal(compared.ranking[2].id, "task_agy_1");
  assert.equal(compared.recommendedWinner.id, "task_claude_1");
  assert.equal(compared.recommendedWinner.harness, "claude");

  // Default synthesis uses recommendedWinner
  const defaultSynthesis = synthesizeComparison(parallelRuns);
  assert.equal(defaultSynthesis.ok, true);
  assert.equal(defaultSynthesis.totalRuns, 3);
  assert.equal(defaultSynthesis.selectedWinner.id, "task_claude_1");
  assert.match(defaultSynthesis.synthesisSummary, /Recommended: claude/i);
  assert.match(defaultSynthesis.synthesisSummary, /lib\/pi-acp\.mjs/);
  assert.match(defaultSynthesis.mergedPatchPreview, /Primary candidate: claude/);
  assert.match(defaultSynthesis.mergedPatchPreview, /tests\/pi-acp\.test\.mjs/);

  // Manual override via selectedWinnerId
  const overridden = synthesizeComparison(parallelRuns, { selectedWinnerId: "task_pi_1" });
  assert.equal(overridden.selectedWinner.id, "task_pi_1");
  assert.equal(overridden.selectedWinner.harness, "pi");
  assert.equal(overridden.selectedWinner.overridden, true);
  assert.match(overridden.mergedPatchPreview, /Primary candidate: pi/);
});

test("agent-monitor.html includes side-by-side comparison UI, compare_harness_results tool, and zero plain-language violations", () => {
  const rawHtml = fs.readFileSync(
    new URL("../public/apps/agent-monitor.html", import.meta.url),
    "utf8",
  );

  assert.match(rawHtml, /id="compare-results-panel"/);
  assert.match(rawHtml, /id="synthesis-summary"/);
  assert.match(rawHtml, /id="comparison-grid"/);
  assert.match(rawHtml, /Select Winning Patch/);
  assert.match(rawHtml, /data-select-winner/);
  assert.match(rawHtml, /compare_harness_results/);

  const hits = scanPlainLanguage(rawHtml);
  assert.deepEqual(
    hits,
    [],
    `Expected zero plain-language violations in public/apps/agent-monitor.html, found: ${JSON.stringify(hits)}`,
  );
});
