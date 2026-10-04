// lib/harness-comparison.mjs — Multi-Harness Result Comparison & Automated Diff Synthesis.
// Pure, zero-dependency module for scoring parallel harness runs, extracting touched files,
// ranking candidates, and synthesizing a side-by-side comparison report.

const DIFF_GIT_RE = /^diff --git a\/([^\s]+) b\/([^\s]+)$/gm;
const DIFF_HEADER_RE = /^(?:---|\+\+\+) (?:a\/|b\/)?([^\s\t\r\n]+)$/gm;
const INLINE_PATH_RE =
  /(?:^|[\s`"'([:])((?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{1,8})(?=$|[\s`"'),.:;\]])/gm;

function cleanCandidatePath(raw) {
  if (!raw || typeof raw !== "string") return null;
  let trimmed = raw.trim().replace(/^[ab]\//, "");
  if (!trimmed || trimmed === "/dev/null" || trimmed === "dev/null") return null;
  if (/^(?:https?:|file:|ws:|wss:|mailto:)/i.test(trimmed)) return null;
  if (trimmed.startsWith("/")) trimmed = trimmed.slice(1);
  if (!trimmed || trimmed.includes("..")) return null;
  return trimmed;
}

/**
 * Extract unique relative file paths from unified diff headers or output text.
 */
export function extractDiffFiles(text = "") {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  const seen = new Set();
  const add = (candidate) => {
    const cleaned = cleanCandidatePath(candidate);
    if (cleaned) seen.add(cleaned);
  };

  for (const match of source.matchAll(DIFF_GIT_RE)) {
    add(match[2]);
    add(match[1]);
  }

  for (const match of source.matchAll(DIFF_HEADER_RE)) {
    const raw = match[1];
    if (raw === "/dev/null" || raw === "dev/null") continue;
    add(raw);
  }

  for (const match of source.matchAll(INLINE_PATH_RE)) {
    const raw = match[1];
    if (/^(?:a|b)\//.test(raw)) {
      add(raw.slice(2));
    } else if (!/^(?:application|text|audio|video|image|multipart)\//i.test(raw)) {
      add(raw);
    }
  }

  return Array.from(seen);
}

function resolveDurationMs(run) {
  if (typeof run?.durationMs === "number" && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
    return Math.round(run.durationMs);
  }
  if (run?.createdAt && run?.updatedAt) {
    const start = Date.parse(run.createdAt);
    const end = Date.parse(run.updatedAt);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      return Math.round(end - start);
    }
  }
  return 0;
}

/**
 * Score a single harness task run based on completion status, output richness,
 * extracted diff files, and execution speed.
 */
export function scoreHarnessRun(run = {}) {
  const status = String(run?.status || run?.state || "running").toLowerCase();
  const rawOutput = String(
    run?.resultSummary ?? run?.output ?? run?.answer ?? run?.detail ?? "",
  );
  const outputLength = rawOutput.trim().length;

  const explicitFiles = Array.isArray(run?.filesChanged)
    ? run.filesChanged.map((f) => cleanCandidatePath(String(f))).filter(Boolean)
    : [];
  const extractedFiles = extractDiffFiles(rawOutput);
  const filesTouched = Array.from(new Set([...explicitFiles, ...extractedFiles]));
  const durationMs = resolveDurationMs(run);

  let baseScore = 0;
  if (status === "completed") {
    baseScore = 100;
  } else if (status === "running" || status === "queued") {
    baseScore = 40;
  } else {
    baseScore = 0;
  }

  let score = baseScore;
  if (baseScore > 0) {
    if (outputLength > 0) score += 15;
    if (filesTouched.length > 0) score += 15;
    const speedBonus =
      durationMs > 0
        ? Math.max(1, Math.min(20, Math.round(20 / (1 + durationMs / 5000))))
        : 10;
    score += speedBonus;
  }

  return {
    score,
    status,
    durationMs,
    outputLength,
    filesTouched,
  };
}

/**
 * Compare multiple harness runs, computing shared/unique touched files,
 * ranked runs, and the recommended winning completed run.
 */
export function compareHarnessRuns(runs = []) {
  const list = Array.isArray(runs) ? runs : [];

  const normalized = list.map((run, index) => {
    const scored = scoreHarnessRun(run);
    const id = String(run?.id || run?.address || `run_${index + 1}`);
    const harness = String(run?.harness || run?.agent || "unknown").toLowerCase();
    const prompt = String(run?.prompt || run?.task || "");
    const summary = String(
      run?.resultSummary ?? run?.output ?? run?.answer ?? run?.detail ?? "",
    );

    return {
      id,
      harness,
      status: scored.status,
      prompt,
      summary,
      durationMs: scored.durationMs,
      outputLength: scored.outputLength,
      filesTouched: scored.filesTouched,
      score: scored.score,
    };
  });

  const harnesses = Array.from(new Set(normalized.map((r) => r.harness)));

  // Map file -> Set of harnesses that touched it
  const fileHarnesses = new Map();
  for (const item of normalized) {
    for (const file of item.filesTouched) {
      if (!fileHarnesses.has(file)) {
        fileHarnesses.set(file, new Set());
      }
      fileHarnesses.get(file).add(item.harness);
    }
  }

  const sharedFiles = [];
  for (const [file, owners] of fileHarnesses.entries()) {
    if (owners.size >= 2) {
      sharedFiles.push(file);
    }
  }

  const uniqueFilesByHarness = {};
  for (const h of harnesses) {
    uniqueFilesByHarness[h] = [];
  }
  for (const [file, owners] of fileHarnesses.entries()) {
    if (owners.size === 1) {
      const [soleHarness] = owners;
      if (!uniqueFilesByHarness[soleHarness]) {
        uniqueFilesByHarness[soleHarness] = [];
      }
      uniqueFilesByHarness[soleHarness].push(file);
    }
  }

  const ranking = [...normalized].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const durA = a.durationMs > 0 ? a.durationMs : Number.MAX_SAFE_INTEGER;
    const durB = b.durationMs > 0 ? b.durationMs : Number.MAX_SAFE_INTEGER;
    return durA - durB;
  });

  const topCompleted = ranking.find((r) => r.status === "completed") || null;
  const recommendedWinner = topCompleted
    ? {
        id: topCompleted.id,
        harness: topCompleted.harness,
        score: topCompleted.score,
        durationMs: topCompleted.durationMs,
        filesTouched: topCompleted.filesTouched,
        reason: buildWinnerReason(topCompleted),
      }
    : null;

  return {
    harnesses,
    sharedFiles,
    uniqueFilesByHarness,
    ranking,
    recommendedWinner,
  };
}

function formatDurationShort(durationMs) {
  if (!durationMs || durationMs <= 0) return "under 1s";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function buildWinnerReason(run) {
  const fileCount = run.filesTouched.length;
  const filesPhrase =
    fileCount === 1 ? "1 file touched" : `${fileCount} files touched`;
  return `Completed in ${formatDurationShort(run.durationMs)} with ${filesPhrase} (score ${run.score})`;
}

/**
 * Synthesize a comparison report and merged patch preview across harness runs,
 * allowing an optional manual winner override (`selectedWinnerId`).
 */
export function synthesizeComparison(runs = [], { selectedWinnerId = null } = {}) {
  const comparison = compareHarnessRuns(runs);
  const { harnesses, sharedFiles, uniqueFilesByHarness, ranking, recommendedWinner } =
    comparison;

  let selectedWinner = recommendedWinner;
  if (selectedWinnerId) {
    const manual = ranking.find(
      (r) => r.id === selectedWinnerId || r.harness === selectedWinnerId,
    );
    if (manual) {
      selectedWinner = {
        id: manual.id,
        harness: manual.harness,
        score: manual.score,
        durationMs: manual.durationMs,
        filesTouched: manual.filesTouched,
        reason: `Selected by operator (${buildWinnerReason(manual)})`,
        overridden: true,
      };
    }
  }

  let synthesisSummary = "No harness runs available to compare yet.";
  if (ranking.length > 0) {
    if (selectedWinner) {
      const winnerRun = ranking.find((r) => r.id === selectedWinner.id) || selectedWinner;
      const fileCount = winnerRun.filesTouched?.length ?? 0;
      const filesPhrase = fileCount === 1 ? "1 file touched" : `${fileCount} files touched`;
      const sharedPhrase =
        sharedFiles.length > 0
          ? ` Shared files across harnesses: ${sharedFiles.join(", ")}.`
          : "";
      synthesisSummary = `Recommended: ${selectedWinner.harness} (completed in ${formatDurationShort(selectedWinner.durationMs)}, ${filesPhrase}).${sharedPhrase}`;
    } else {
      synthesisSummary = `Comparing ${ranking.length} active runs across ${harnesses.join(", ")} — waiting for first completion.`;
    }
  }

  const winnerFull = selectedWinner
    ? ranking.find((r) => r.id === selectedWinner.id)
    : ranking[0];
  const mergedLines = [];
  if (winnerFull) {
    mergedLines.push(
      `# Primary candidate: ${winnerFull.harness} (${winnerFull.id})`,
    );
    if (winnerFull.summary) {
      mergedLines.push(winnerFull.summary.trim());
    }
    for (const other of ranking) {
      if (other.id === winnerFull.id || other.status !== "completed") continue;
      const extraFiles = uniqueFilesByHarness[other.harness] || [];
      if (extraFiles.length > 0) {
        mergedLines.push(
          `\n# Additional unique files from ${other.harness}: ${extraFiles.join(", ")}`,
        );
      }
    }
  }

  return {
    ok: true,
    totalRuns: ranking.length,
    harnesses,
    ranking,
    recommendedWinner,
    selectedWinner,
    sharedFiles,
    uniqueFilesByHarness,
    synthesisSummary,
    mergedPatchPreview: mergedLines.join("\n").trim(),
  };
}
