// tools/factory-issue-commenter.mjs — formats safe issue triage comments from Factory reports.
//
// Rules (voicebox-beads-cbxo, voicebox-beads-jyj1):
// 1. Logs safe triage summary directly on the triggering GitHub issue.
// 2. Embeds shared markers per finding:
//    <!-- factory-triage-comment: <fingerprint> -->
//    <!-- factory-station: <station> -->
//    <!-- factory-severity: <severity> -->
//    <!-- factory-state: <state> -->
//    so h1u0 --review/--promote can inspect comments and promote reviewed findings to Beads.
// 3. Deduplication: inspects existing issue comments. If all findings are already commented,
//    returns exitCode: 2 (no-op) so repeated polls/edits post zero duplicate comments.
//    If new findings exist, comments ONLY on newly discovered finding sections.
// 4. Never creates replacement issues or beads automatically at scan time.
// 5. Never echoes raw credentials, secrets, or unredacted PoC payloads in issue text.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { redactSecrets } from "../lib/redact.mjs";

const SECURITY_STATIONS = new Set(["vuln-discovery", "vuln-triage", "vuln-verify", "secret-scan", "deps-supply-chain"]);

/**
 * Format a safe, sanitized markdown triage comment from a directory of factory reports.
 *
 * @param {object} options
 * @param {string[]} options.stations - List of stations executed
 * @param {string} [options.findingsDir] - Directory holding factory markdown reports
 * @param {string} [options.commitSha] - Commit SHA scanned
 * @param {Array<string|object>} [options.existingComments] - Existing comments on the issue for dedupe
 * @returns {{ ok: boolean, exitCode: number, newFindings: number, totalFindings: number, comment: string }}
 */
export function formatTriageComment({ stations = [], findingsDir = "", commitSha = "", existingComments = [] } = {}) {
  // 1. Extract existing fingerprints from prior issue comments
  const existingFingerprints = new Set();
  for (const c of existingComments) {
    const text = typeof c === "string" ? c : String(c?.body ?? "");
    const matches = text.matchAll(/<!--\s*factory-triage-comment:\s*([0-9a-f]{16,64})\s*-->/gi);
    for (const m of matches) {
      existingFingerprints.add(m[1].toLowerCase());
    }
  }

  const reports = [];
  if (findingsDir && existsSync(findingsDir)) {
    try {
      const files = readdirSync(findingsDir);
      for (const f of files) {
        if (f.endsWith("-summary.md") || f.endsWith("-latest.md") || f.endsWith("-delta.md")) {
          const content = readFileSync(path.join(findingsDir, f), "utf8");
          reports.push({ file: f, content });
        }
      }
    } catch (e) {
      // Handled downstream
    }
  }

  // 2. Parse findings from reports
  let totalFindings = 0;
  const findingItems = [];

  for (const report of reports) {
    const rawLines = report.content.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const m = line.match(/^-\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+\[?([a-z0-9_-]+)\]?\s+(.*)$/i);
      if (m) {
        totalFindings++;
        const sev = m[1].toUpperCase();
        const station = m[2];
        let description = m[3].trim();
        let state = "new";
        let humanReview = SECURITY_STATIONS.has(station);

        // Check next few lines for fingerprint or state
        let fingerprint = "";
        for (let j = i + 1; j < Math.min(rawLines.length, i + 8); j++) {
          if (/^-\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]/i.test(rawLines[j])) {
            break;
          }
          if (/human[-_]?review:\s*true/i.test(rawLines[j]) || /<!--\s*factory-human-review\s*-->/i.test(rawLines[j])) {
            humanReview = true;
          }
          const fpMatch = rawLines[j].match(/fingerprint:\s*`?([0-9a-f]{16,64})`?/i) ||
                          rawLines[j].match(/<!--\s*factory-fingerprint:\s*([0-9a-f]{16,64})\s*-->/i);
          if (fpMatch && !fingerprint) {
            fingerprint = fpMatch[1].toLowerCase();
          }
          const stateMatch = rawLines[j].match(/<!--\s*factory-state:\s*(new|regressed)\s*-->/i) ||
                            rawLines[j].match(/state:\s*(new|regressed)/i);
          if (stateMatch) {
            state = stateMatch[1].toLowerCase();
          }
        }
        if (!fingerprint) {
          fingerprint = createHash("sha256").update(`${station}:${sev}:${description}`).digest("hex");
        }

        // Sanitize: strip credential patterns or secret tokens if present
        description = sanitizeFindingText(description);

        findingItems.push({ severity: sev, station, description, fingerprint, state, humanReview });
      }
    }
  }

  // 3. Filter out findings already commented on this issue
  const newFindings = findingItems.filter((f) => !existingFingerprints.has(f.fingerprint.toLowerCase()));

  // Deduplication check: if all reported findings are already commented on this issue, return no-op exit 2
  if (totalFindings > 0 && newFindings.length === 0) {
    return {
      ok: true,
      exitCode: 2,
      newFindings: 0,
      totalFindings,
      comment: "",
    };
  }

  // 4. Render markdown comment body
  const stationList = stations.length > 0 ? stations.map((s) => `\`${s}\``).join(", ") : "*(none)*";
  const lines = [
    "### 🤖 Software Factory Automated Triage",
    "",
    `**Stations Executed**: ${stationList}`,
  ];

  if (commitSha) {
    lines.push(`**Commit Scanned**: \`${commitSha.slice(0, 10)}\``);
  }
  lines.push("");

  if (totalFindings === 0) {
    lines.push("✅ **No new findings discovered** across the executed stations.");
  } else {
    lines.push(`#### Discovered Findings (${newFindings.length}${totalFindings !== newFindings.length ? ` new, ${totalFindings - newFindings.length} already triaged` : ""})`);
    lines.push("");

    const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], INFO: [] };
    for (const item of newFindings) {
      if (bySeverity[item.severity]) {
        bySeverity[item.severity].push(item);
      } else {
        bySeverity.INFO.push(item);
      }
    }

    for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]) {
      const items = bySeverity[sev];
      if (items.length > 0) {
        lines.push(`- **${sev}** (${items.length}):`);
        for (const it of items) {
          lines.push(`  - [\`${it.station}\`] ${it.description}`);
          // Embed all shared triage markers per finding
          lines.push(`    <!-- factory-triage-comment: ${it.fingerprint} -->`);
          lines.push(`    <!-- factory-station: ${it.station} -->`);
          lines.push(`    <!-- factory-severity: ${it.severity.toLowerCase()} -->`);
          lines.push(`    <!-- factory-state: ${it.state} -->`);
          if (it.humanReview) {
            lines.push(`    <!-- factory-human-review -->`);
          }
        }
      }
    }
  }

  lines.push("");
  lines.push("> ℹ️ *Findings are logged for issue review. Work beads are created only after human review approval.*");

  return {
    ok: true,
    exitCode: 0,
    newFindings: newFindings.length,
    totalFindings,
    comment: lines.join("\n"),
  };
}

/**
 * Thoroughly sanitize finding descriptions using Voicebox's standard redactSecrets
 * plus explicit GitHub/OAuth token redactors.
 */
export function sanitizeFindingText(text = "") {
  let sanitized = redactSecrets(String(text));
  sanitized = sanitized.replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, "[REDACTED]");
  return sanitized;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const findingsDir = process.env.FINDINGS_DIR || process.argv[2] || "";
  const rawStations = process.env.STATIONS || process.argv[3] || "[]";
  const commitSha = process.env.GITHUB_SHA || process.argv[4] || "";

  let stations = [];
  try {
    stations = JSON.parse(rawStations);
  } catch {
    stations = rawStations ? rawStations.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }

  const result = formatTriageComment({ stations, findingsDir, commitSha });
  if (result.comment) {
    console.log(result.comment);
  }
  process.exit(result.exitCode);
}
