// lib/redact.mjs — Sensitive token & credential scrubber for console logs and agent activity.
//
// Ensures API keys, bearer tokens, private keys, passwords, and environment secrets
// are never surfaced in user-facing activity logs, session history, or task card UI.

const SENSITIVE_KEYS = new Set([
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "VOICEBOX_HOST_TOKEN",
  "VOICEBOX_SESSION_TOKEN",
]);

const SENSITIVE_KEY_PATTERN = /auth|headers|cookie|password|passwd|secret|token|credential|key|signature/i;
const REDACTED = "[redacted]";

/**
 * Collect all active secret strings from process.env that are long enough (>= 6 chars)
 * to be meaningful secrets rather than common short substrings.
 */
function getKnownEnvSecrets() {
  const secrets = [];
  try {
    for (const [key, val] of Object.entries(process.env)) {
      if (typeof val !== "string" || val.length < 6) continue;
      if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
        secrets.push(val);
      }
    }
  } catch {}
  return secrets;
}

/**
 * The BARE, context-free credential shapes - the single owner for public-output masking.
 *
 * Callers must use this rather than keeping a private copy: a shape added here has to protect
 * EVERY public surface (published issue body, issue comment, log line). The set is the union of
 * what this module already masked and the shapes the factory mirror carried, so centralising it
 * cannot lose coverage.
 *
 * The patterns are deliberately BOUNDARY-FREE. An earlier form of this owner guarded each shape with
 * \b, which is NARROWER than the set it replaces: the mirrored table in scripts/factory-triage.mjs
 * (itself a mirror of lib/redaction.py:ALL_PATTERNS) matches with no boundary guards, so a token glued
 * to a word character would have stopped being masked. A redactor must over-match rather than
 * under-match, so the owner takes the widest form of every shape it is responsible for
 * (voicebox-beads-7cvr).
 */
// Each pattern is anchored on the LEFT by a negative lookbehind, not by \b: a token glued to a
// letter is part of a word, not a token. Without it, `sk-` matched inside `task-runner` and the
// publisher masked six ordinary task-* words in one sentence (reviewer P1 on this change). The
// lookbehind still allows any punctuation, whitespace or quote before a token, and it is wider
// than the \b the owner used before - \b refuses `_sk-...`, this does not - so it cannot narrow.
export const BARE_TOKEN_SHAPES = [
  ["pem-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["openai-key", /(?<![A-Za-z0-9])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{6,}/g],
  ["stripe-key", /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["google-api-key", /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{6,}/g],
  ["google-oauth", /(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/g],
  ["gitlab-pat", /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g],
  ["npm-token", /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g],
  ["aws-access-key", /(?<![A-Za-z0-9])(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g],
  ["github-pat", /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["slack-token", /(?<![A-Za-z0-9])xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g],
  ["jwt-token", /(?<![A-Za-z0-9])ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

/** Mask every BARE_TOKEN_SHAPES match. One implementation, so the surfaces cannot drift apart. */
export function redactBareTokens(text) {
  let out = String(text);
  for (const [, pattern] of BARE_TOKEN_SHAPES) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Redact sensitive strings and credentials from a text string.
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let result = text;

  // 1. Redact known environment secrets if present
  const envSecrets = getKnownEnvSecrets();
  for (const secret of envSecrets) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, REDACTED);
    }
  }

  // 2. Redact standard credential patterns (keys, tokens, headers, private keys)
  result = result
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:[^\r\n]*/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, REDACTED)
    .replace(/((?:api[-_ ]?key|[a-z0-9_]*key|password|passwd|secret|token|credential|signature)\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, `$1"${REDACTED}"`)
    .replace(/((?:api[-_ ]?key|[a-z0-9_]*key|password|passwd|secret|token|credential|signature)\s*["']?\s*[:=]\s*["']?)[^\s,;&"'}]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);

  // 3. Bare, context-free credential shapes - delegated so there is exactly one owner of them
  result = redactBareTokens(result);

  return result;
}

/**
 * Deeply redact sensitive strings in an object or array.
 */
export function redactObject(val) {
  if (typeof val === "string") return redactSecrets(val);
  if (Array.isArray(val)) return val.map(redactObject);
  if (val && typeof val === "object") {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        res[k] = REDACTED;
      } else {
        res[k] = redactObject(v);
      }
    }
    return res;
  }
  return val;
}
