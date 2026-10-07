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
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(?:AIza[A-Za-z0-9_-]{6,}|sk-(?:ant-)?[A-Za-z0-9_-]{6,})\b/g, REDACTED);

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
