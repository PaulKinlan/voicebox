// tools/factory-issue-router.mjs — deterministic classification & station mapping for diffs & issues.
//
// Rules (voicebox-beads-cbxo, voicebox-beads-jyj1):
// 1. Priority order: Security > Perf > UX > Docs > Ops.
// 2. Diff review trigger: bounded to AT MOST ONE station per review. Mixed diffs run the top station
//    and explicitly record secondary matching stations as DEFERRED for the nightly line.
// 3. Inbound issue routing: deterministic keyword/label classification with fail-closed author trust gate.
// 4. Loop Hazard Guard: skips any issue published by factory sinks or triage tools (matching body
//    fingerprint markers or factory: / factory/ title prefixes) independent of author association.

import { createHash } from "node:crypto";

/** Trusted GitHub author associations for inbound issue scanning */
export const TRUSTED_AUTHORS = new Set(["OWNER", "COLLABORATOR", "MEMBER"]);

/** Domain categories mapped to primary and fallback factory stations */
export const CATEGORY_STATIONS = {
  security: ["secret-scan", "deps-supply-chain"],
  perf: ["perf-review", "bundle-size"],
  ux: ["ui-ux-audit", "accessibility", "modern-web"],
  docs: ["docs-drift"],
  ops: ["log-check", "issue-triage"],
};

/** Category evaluation priority order */
export const PRIORITY_ORDER = ["security", "perf", "ux", "docs", "ops"];

/** Keyword & path patterns for domain detection */
export const DOMAIN_PATTERNS = {
  security: {
    paths: [
      /credentials?/i,
      /secrets?/i,
      /auth/i,
      /token/i,
      /lib\/redact\.mjs/i,
      /package(-lock)?\.json/i,
      /\.env/i,
    ],
    terms: ["security", "vulnerability", "cve", "secret", "credential", "token leak", "xss", "traversal", "auth"],
  },
  perf: {
    paths: [
      /server\.mjs/i,
      /lib\/ws-server\.mjs/i,
      /lib\/tasks\.mjs/i,
      /public\/.*\.js/i,
      /wasm/i,
      /memory/i,
    ],
    terms: ["performance", "perf", "latency", "slow", "memory leak", "heap", "bundle size", "waterfall", "lag"],
  },
  ux: {
    paths: [
      /public\/.*\.css/i,
      /public\/.*\.html/i,
      /browser\//i,
      /designs\//i,
      /style\.css/i,
    ],
    terms: ["ui", "ux", "accessibility", "a11y", "wcag", "popover", "dialog", "container query", "contrast", "tap target", "focus"],
  },
  docs: {
    paths: [
      /docs\//i,
      /.*\.md$/i,
      /PRODUCT\.md/i,
      /README\.md/i,
    ],
    terms: ["documentation", "docs", "docs drift", "readme", "broken link", "typo in doc", "specification"],
  },
  ops: {
    paths: [
      /scripts\//i,
      /tools\//i,
    ],
    terms: ["ops", "bug", "crash", "stack trace", "error", "unhandled rejection", "broken", "failure"],
  },
};

/**
 * Deterministically maps a set of changed file paths to at most ONE station for a review change-set.
 * If multiple domains match, runs the top-priority domain's station and marks other domains as deferred.
 *
 * @param {string[]} changedFiles - Array of repository-relative file paths changed in base..tip
 * @returns {{ station: string, category: string, deferred: Array<{ category: string, station: string }>, matchedCategories: string[] }}
 */
export function selectReviewStation(changedFiles = []) {
  const matchedCategories = [];

  for (const cat of PRIORITY_ORDER) {
    const patterns = DOMAIN_PATTERNS[cat]?.paths || [];
    const hasMatch = changedFiles.some((file) => patterns.some((re) => re.test(file)));
    if (hasMatch) {
      matchedCategories.push(cat);
    }
  }

  // Fallback if no specific paths matched (e.g. general files)
  if (matchedCategories.length === 0) {
    matchedCategories.push("ops");
  }

  const primaryCategory = matchedCategories[0];
  const primaryStation = CATEGORY_STATIONS[primaryCategory][0];

  const deferred = [];
  for (let i = 1; i < matchedCategories.length; i++) {
    const cat = matchedCategories[i];
    deferred.push({
      category: cat,
      station: CATEGORY_STATIONS[cat][0],
    });
  }

  return {
    station: primaryStation,
    category: primaryCategory,
    deferred,
    matchedCategories,
  };
}

/**
 * Computes a deterministic cache fingerprint for a review diff.
 *
 * @param {object} params
 * @param {string} params.diffContent - git diff output string
 * @param {string} params.station - target station name
 * @param {string} params.factoryRef - pinned factory commit hash or version
 * @returns {string} SHA-256 fingerprint hex
 */
export function computeReviewCacheKey({ diffContent = "", station = "", factoryRef = "" } = {}) {
  const diffHash = createHash("sha256").update(diffContent).digest("hex");
  return createHash("sha256")
    .update(`${diffHash}:${station}:${factoryRef}`)
    .digest("hex");
}

/**
 * Classifies an inbound GitHub issue payload and returns target stations.
 *
 * @param {object} issue - GitHub issue payload
 * @returns {{ ok: boolean, authorTrusted: boolean, reason?: string, categories: string[], agents: string[] }}
 */
export function routeIssue(issue = {}) {
  const body = String(issue.body ?? "");
  const title = String(issue.title ?? "");
  const authorAssoc = String(issue.author_association ?? issue.authorAssociation ?? "NONE").toUpperCase();

  // 1. Loop Hazard Guard (independent of author association):
  // Checks body and title markers matching issues created by factory-triage or upstream factory sinks
  if (
    /<!--\s*factory-fingerprint:/i.test(body) ||
    /\*\*Fingerprint\*\*:\s*`?[0-9a-f]{16}/i.test(body) ||
    /<!--\s*factory-self-test\s*-->/i.test(body) ||
    /^\[(human-review\s*\]\s*\[)?factory[:/]/i.test(title.trim())
  ) {
    return {
      ok: false,
      authorTrusted: true,
      reason: "already a published factory finding, not an inbound report",
      categories: [],
      agents: [],
    };
  }

  // 2. Author Association Trust Gate
  const authorTrusted = TRUSTED_AUTHORS.has(authorAssoc);
  if (!authorTrusted) {
    return {
      ok: false,
      authorTrusted: false,
      reason: `author_association '${authorAssoc}' is not in trusted set (${[...TRUSTED_AUTHORS].join(", ")})`,
      categories: [],
      agents: [],
    };
  }

  // 3. Keyword / Label matching across domains
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l) => (typeof l === "string" ? l.toLowerCase() : String(l.name ?? "").toLowerCase()))
    : [];

  const haystack = `${title} ${body} ${labels.join(" ")}`.toLowerCase();
  const matchedCategories = [];

  for (const cat of PRIORITY_ORDER) {
    const terms = DOMAIN_PATTERNS[cat]?.terms || [];
    const hit = terms.some((term) => haystack.includes(term.toLowerCase()));
    if (hit) {
      matchedCategories.push(cat);
    }
  }

  if (matchedCategories.length === 0) {
    matchedCategories.push("ops");
  }

  const agents = new Set();
  for (const cat of matchedCategories) {
    const catAgents = CATEGORY_STATIONS[cat] || [];
    for (const a of catAgents) {
      agents.add(a);
    }
  }

  return {
    ok: true,
    authorTrusted: true,
    categories: matchedCategories,
    agents: [...agents],
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const rawInput = process.env.ISSUE_PAYLOAD || process.argv[2] || "{}";
  let payload = {};
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.error("Invalid JSON input to factory-issue-router");
    process.exit(1);
  }

  const result = routeIssue(payload);
  if (!result.ok) {
    console.error(`[router] refused: ${result.reason}`);
    console.log(JSON.stringify([]));
    process.exit(0);
  }

  console.log(JSON.stringify(result.agents));
}
