// tools/factory-issue-commenter.mjs — formats safe issue triage comments from Factory reports.
//
// Rules (voicebox-beads-cbxo, voicebox-beads-jyj1):
// 1. Logs safe triage summary directly on the triggering GitHub issue.
// 2. Embeds shared marker <!-- factory-triage-comment: <fingerprint> --> so h1u0 --review/--promote
//    can inspect the comment and promote reviewed inbound findings to Beads.
// 3. Never creates replacement issues or beads automatically at scan time.
// 4. Never echoes raw credentials, secrets, or unredacted PoC payloads in issue text.
// 5. Summarizes stations executed, findings count, severity bands, and next review actions.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Format a safe, sanitized markdown triage comment from a directory of factory reports.
 *
 * @param {object} options
 * @param {string[]} options.stations - List of stations executed
 * @param {string} [options.findingsDir] - Directory holding factory markdown reports
 * @param {string} [options.commitSha] - Commit SHA scanned
 * @returns {string} Sanitized markdown comment body
 */
export function formatTriageComment({ stations = [], findingsDir = "", commitSha = "" } = {}) {
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
      lines.push(`> ⚠️ Notice: Could not read findings directory: ${e.message}`);
      lines.push("");
    }
  }

  // Parse findings or summaries
  let totalFindings = 0;
  const findingItems = [];

  for (const report of reports) {
    const rawLines = report.content.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      // Look for bullet findings: - [SEVERITY] [station] title (file:line) or markdown heading
      const m = line.match(/^-\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+\[?([a-z0-9_-]+)\]?\s+(.*)$/i);
      if (m) {
        totalFindings++;
        const sev = m[1].toUpperCase();
        const station = m[2];
        let description = m[3].trim();

        // Check next few lines for fingerprint if present
        let fingerprint = "";
        for (let j = i + 1; j < Math.min(rawLines.length, i + 6); j++) {
          const fpMatch = rawLines[j].match(/fingerprint:\s*`?([0-9a-f]{16,64})`?/i) ||
                          rawLines[j].match(/<!--\s*factory-fingerprint:\s*([0-9a-f]{16,64})\s*-->/i);
          if (fpMatch) {
            fingerprint = fpMatch[1];
            break;
          }
        }
        if (!fingerprint) {
          fingerprint = createHash("sha256").update(`${station}:${sev}:${description}`).digest("hex");
        }

        // Sanitize: strip credential patterns or secret tokens if present
        description = sanitizeFindingText(description);

        findingItems.push({ severity: sev, station, description, fingerprint });
      }
    }
  }

  if (totalFindings === 0) {
    lines.push("✅ **No new findings discovered** across the executed stations.");
  } else {
    lines.push(`#### Discovered Findings (${totalFindings})`);
    lines.push("");

    const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], INFO: [] };
    for (const item of findingItems) {
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
          // Embed the shared triage comment marker per finding
          lines.push(`    <!-- factory-triage-comment: ${it.fingerprint} -->`);
          lines.push(`    <!-- factory-station: ${it.station} -->`);
          lines.push(`    <!-- factory-severity: ${it.severity.toLowerCase()} -->`);
        }
      }
    }
  }

  lines.push("");
  lines.push("> ℹ️ *Findings are logged for issue review. Work beads are created only after human review approval.*");

  return lines.join("\n");
}

/**
 * Basic regex sanitization: mask high-entropy strings, tokens, or credential-shaped values.
 */
export function sanitizeFindingText(text = "") {
  return String(text)
    // Redact generic Bearer/token patterns
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]{8,}/gi, "$1[REDACTED]")
    // Redact API key assignments
    .replace(/(api[_-]?key\s*[:=]\s*)['"][^'"]+['"]/gi, "$1'[REDACTED]'")
    // Redact GitHub/OAuth tokens
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, "[REDACTED_GH_TOKEN]")
    // Redact private key header mentions
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
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

  const comment = formatTriageComment({ stations, findingsDir, commitSha });
  console.log(comment);
}
