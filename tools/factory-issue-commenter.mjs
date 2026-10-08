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

const SECURITY_STATIONS = new Set(["vuln-discovery", "vuln-triage", "vuln-verify", "secret-scan", "threat-model"]);

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

  // 2. Parse findings from reports (supporting both real factory delta format and legacy rows)
  let totalFindings = 0;
  const findingItems = [];

  for (const report of reports) {
    let derivedStation = "";
    if (report.file) {
      for (const st of stations) {
        if (
          report.file.endsWith(`-${st}-delta.md`) ||
          report.file.endsWith(`-${st}-summary.md`) ||
          report.file.endsWith(`-${st}-latest.md`)
        ) {
          derivedStation = st;
          break;
        }
      }
      if (!derivedStation) {
        const mSuffix = report.file.match(/-([a-z0-9_-]+)-(?:delta|summary|latest)\.md$/);
        if (mSuffix) derivedStation = mSuffix[1];
      }
    }
    const rawLines = report.content.split("\n");
    let inActionableSection = false;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (line.startsWith("## ")) {
        inActionableSection = /^## Action Required: New & Regressed Findings/i.test(line);
        continue;
      }

      // Format A: Real Factory Delta Report (### [SEVERITY] Title (`state`))
      const headingMatch = line.match(/^###\s+\[([^\]]+)\]\s+(.*?)(?:\s+\(`([a-z]+)`\))?\s*$/);
      if (inActionableSection && headingMatch && !/FALSE POSITIVE/i.test(headingMatch[1])) {
        const badge = headingMatch[1];
        const badgeParts = badge.split("·");
        const sev = (badgeParts[1] ? badgeParts[1].replace(/routed/i, "").trim() : badgeParts[0].trim()).toUpperCase();
        const title = headingMatch[2].trim();
        let state = headingMatch[3] ? headingMatch[3].toLowerCase() : "new";
        if (state !== "new" && state !== "regressed") {
          continue; // Non-actionable state (fixed, unchanged, etc.)
        }
        totalFindings++;
        const station = derivedStation || (stations.length === 1 ? stations[0] : "unknown");
        let humanReview = SECURITY_STATIONS.has(station);

        let rule = "";
        let location = "";
        let fingerprint = "";
        let description = "";

        for (let j = i + 1; j < rawLines.length; j++) {
          const next = rawLines[j].trim();
          if (next.startsWith("### ") || next.startsWith("## ")) {
            break;
          }
          const ruleMatch = next.match(/^- \*\*Rule\*\*:\s*`?([^`]+)`?/i);
          if (ruleMatch) rule = ruleMatch[1].trim();

          const locMatch = next.match(/^- \*\*Location\*\*:\s*`?([^`]+)`?/i);
          if (locMatch) location = locMatch[1].trim();

          const fpMatch = next.match(/^- \*\*Fingerprint\*\*:\s*`?([0-9a-f]{16,64})`?/i) ||
                          next.match(/fingerprint:\s*`?([0-9a-f]{16,64})`?/i) ||
                          next.match(/<!--\s*factory-fingerprint:\s*([0-9a-f]{16,64})\s*-->/i);
          if (fpMatch && !fingerprint) fingerprint = fpMatch[1].toLowerCase();

          const descMatch = next.match(/^- \*\*Description\*\*:\s*(.*)$/i);
          if (descMatch) description = descMatch[1].trim();

          if (/human[-_]?review:\s*true/i.test(next) || /<!--\s*factory-human-review\s*-->/i.test(next)) {
            humanReview = true;
          }
          const stateMatch = next.match(/<!--\s*factory-state:\s*(new|regressed)\s*-->/i);
          if (stateMatch) state = stateMatch[1].toLowerCase();
        }

        if (!description) description = title;
        if (!fingerprint) {
          fingerprint = createHash("sha256").update(`${station}:${sev}:${rule || description}`).digest("hex");
        }

        if (SECURITY_STATIONS.has(station)) {
          // Withhold raw candidate values, payloads, and tokens for identity-critical security stations
          description = `[withheld: ${station} finding candidate not published; requires human verification]`;
          const rulePrefix = rule ? rule.split(/[=:]/)[0].trim() : "";
          const safeRule = rulePrefix.match(/^[a-zA-Z0-9_-]+$/)?.[0];
          rule = safeRule || "security-finding";

          const cleanLoc = location ? location.split(/[?=;&\s]/)[0].trim() : "";
          const safeLoc = cleanLoc.match(/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+(?::\d+)?$/)?.[0];
          location = safeLoc || "[withheld]";
        }

        description = sanitizeFindingText(description);
        if (rule) rule = sanitizeFindingText(rule);
        if (location) location = sanitizeFindingText(location);

        findingItems.push({ severity: sev, station, description, rule, location, fingerprint, state, humanReview });
        continue;
      }

      // Format B: Legacy synthetic row format (- [SEVERITY] [station] description)
      const hasActionRequiredSection = /^## Action Required: New & Regressed Findings/m.test(report.content);
      const isActionable = hasActionRequiredSection ? inActionableSection : true;
      const m = line.match(/^-\s+\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s+\[?([a-z0-9_-]+)\]?\s+(.*)$/i);
      if (isActionable && m) {
        totalFindings++;
        const sev = m[1].toUpperCase();
        const station = m[2];
        let description = m[3].trim();
        let state = "new";
        let humanReview = SECURITY_STATIONS.has(station);

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

        if (SECURITY_STATIONS.has(station)) {
          description = `[withheld: ${station} finding candidate not published; requires human verification]`;
        }

        description = sanitizeFindingText(description);
        findingItems.push({ severity: sev, station, description, rule: "triaged", fingerprint, state, humanReview });
      }
    }
  }

  // Deduplicate findingItems across delta/summary/latest report variants
  const dedupedFindings = [];
  const seenFp = new Set();
  for (const item of findingItems) {
    const key = item.fingerprint.toLowerCase();
    if (!seenFp.has(key)) {
      seenFp.add(key);
      dedupedFindings.push(item);
    }
  }

  // 3. Filter out findings already commented on this issue
  const newFindings = dedupedFindings.filter((f) => !existingFingerprints.has(f.fingerprint.toLowerCase()));

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

  // 4. Render markdown comments (one comment per finding to avoid marker attribution confusion)
  const stationList = stations.length > 0 ? stations.map((s) => `\`${s}\``).join(", ") : "*(none)*";
  const comments = [];

  if (totalFindings === 0) {
    const cleanLines = [
      "### 🤖 Software Factory Automated Triage",
      "",
      `**Stations Executed**: ${stationList}`,
    ];
    if (commitSha) {
      cleanLines.push(`**Commit Scanned**: \`${commitSha.slice(0, 10)}\``);
    }
    cleanLines.push("");
    cleanLines.push("✅ **No new findings discovered** across the executed stations.");
    comments.push(cleanLines.join("\n"));
  } else {
    for (const item of newFindings) {
      const effectiveRule = item.rule || "triaged";
      const lines = [
        "### 🤖 Software Factory Automated Triage",
        "",
        `- [**\`${item.station}\`**] \`[${item.severity}]\` ${item.description}${item.location ? ` (\`${item.location}\`)` : ""}`,
        `  - **Rule**: \`${effectiveRule}\``,
        "",
        `<!-- factory-triage-comment: ${item.fingerprint} -->`,
        `<!-- factory-station: ${item.station} -->`,
        `<!-- factory-severity: ${item.severity.toLowerCase()} -->`,
        `<!-- factory-state: ${item.state} -->`,
        `<!-- factory-rule: ${effectiveRule} -->`,
      ];
      if (item.humanReview) {
        lines.push(`<!-- factory-human-review -->`);
      }
      lines.push("");
      lines.push("> ℹ️ *Finding logged for issue review. Work beads are created only after human review approval.*");
      comments.push(lines.join("\n"));
    }
  }

  return {
    ok: true,
    exitCode: 0,
    newFindings: newFindings.length,
    totalFindings,
    comments,
    comment: comments.join("\n\n---\n\n"),
  };
}

/**
 * Thoroughly sanitize finding descriptions using Voicebox's standard redactSecrets
 * plus explicit GitHub/OAuth token redactors (including fine-grained PATs: github_pat_...).
 */
export function sanitizeFindingText(text = "") {
  let sanitized = redactSecrets(String(text));
  sanitized = sanitized.replace(/(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,})/g, "[REDACTED]");
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
