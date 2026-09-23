// The provider seam. A resolver turns a transcript into an ACTION:
//   { verb, name, content? }
// The server executes actions; it never parses language itself. Swap the
// resolver to swap the brain — the page and server stay untouched.
//
// Registered today:
//   "script" — a tiny deterministic parser so the loop runs with no model
//              and no key. THIS IS A PLACEHOLDER BRAIN, not the product.
//   "gemini" — the first model-backed resolver (generateContent, structured
//              JSON out, same contract). Selected with VOICEBOX_RESOLVER=gemini
//              (the old name VOICEBOX_PROVIDER is still honoured for one release).
//   Planned: "openai-realtime" — see docs/00-brief.md. The interface those
//   implement is exactly this function's contract.

import { COMMANDS, COMMAND_VERBS, commandToAction } from "./commands.mjs";

const resolvers = {};

export function registerResolver(name, fn) {
  resolvers[name] = fn;
}

export async function resolveTurn(transcript, provider = "script") {
  const fn = resolvers[provider];
  if (!fn) return { unresolved: `no resolver registered for '${provider}'` };
  return await fn(transcript);
}

/**
 * The providers registered right now — so a document can be CHECKED against the
 * code instead of describing it. Added for the docs drift check
 * (`scripts/docs-check.mjs`, `tests/docs-drift.test.mjs`): a list kept current by
 * remembering is the thing that contradicts itself within a week.
 */
export function registeredResolvers() {
  return Object.keys(resolvers).sort();
}

// ── the script resolver: a few verbs, no model ─────────────────────────────
// Parses: "create/write a file called <name> (with|containing) <content>",
//         "read <name>", "list files". Anything else is unresolved — the UI
//         says so instead of pretending.
registerResolver("script", (transcript) => {
  const t = transcript.toLowerCase();

  // ── the model's authoring door (N10): nouns and verbs FROM THE UTTERANCE ──
  // "create a tool called <name> that <verb phrase>" builds a descriptor —
  // data, not code. The proposal lands pending in workspace/proposals/ and
  // the HOST decides whether it loads; this resolver cannot register.
  const toolMake = t.match(/create a tool called ([a-z0-9_-]+) that (.+)/);
  if (toolMake) {
    const [, name, rest] = toolMake;
    const base = { id: `${name}-tool`, name, description: transcript.trim(), source: "model", runsIn: "host", tools: [] };
    const time = rest.match(/tells? (?:me )?the (?:time|date|time and date)|what time/);
    const list = rest.match(/lists? (?:the )?files/);
    const read = rest.match(/reads? ([\w./-]+)/);
    const write = rest.match(/writes? ([\w./-]+)(?: with (.*))?/);
    const get = rest.match(/gets? (https?:\/\/[^\s,;]+)/);
    if (time) return { verb: "make-tool", tool: { ...base, capabilities: [], bounds: {}, tools: [{ name, description: base.description, primitive: "now", params: {} }] } };
    if (list) return { verb: "make-tool", tool: { ...base, capabilities: ["read"], bounds: {}, tools: [{ name, description: base.description, primitive: "list-files", params: {} }] } };
    if (read) return { verb: "make-tool", tool: { ...base, capabilities: ["read"], bounds: {}, tools: [{ name, description: base.description, primitive: "read-file", params: { path: read[1] } }] } };
    if (write) return { verb: "make-tool", tool: { ...base, capabilities: ["write"], bounds: { maxBytes: 65536 }, tools: [{ name, description: base.description, primitive: "write-file", params: { path: write[1], content: (write[2] ?? "").replace(/^"|"$/g, "") } }] } };
    if (get) {
      const host = new URL(get[1]).hostname;
      return { verb: "make-tool", tool: { ...base, capabilities: ["network"], bounds: { hosts: [host], maxRequests: 5 }, tools: [{ name, description: base.description, primitive: "http-get", params: { url: get[1] } }] } };
    }
    return { unresolved: `the script resolver builds tools from: tells the time, lists files, reads <path>, writes <path> with <content>, gets <url> — got: "${rest.slice(0, 60)}". A model resolver goes further.` };
  }

  // ── calling an ADMITTED tool ──────────────────────────────────────────
  const toolCall = t.match(/^(?:run|call|use) the tool ([a-z0-9_-]+)(?:\s+(.*))?$/);
  if (toolCall) return { verb: "tool", name: toolCall[1], args: toolCall[2] ? { url: toolCall[2] } : {} };

  const write = t.match(/(?:create|write|make)\s+(?:a\s+)?(?:file\s+)?(?:called\s+)?["']?([\w.-]+)["']?\s*(?:with|containing)?\s*(.*)/);
  if (write) {
    const [, name, rest] = write;
    const content = rest.replace(/^(with|containing)\s+/, "").replace(/^["']|["']$/g, "");
    return { verb: "write", name, content };
  }

  const read = t.match(/^read\s+["']?([\w.-]+)["']?$/);
  if (read) return { verb: "read", name: read[1] };

  if (/\blist\b.*\bextensions\b/.test(t)) return { verb: "extensions", name: "" };
  if (/\blist\b/.test(t)) return { verb: "list", name: "" };

  return { unresolved: `the script resolver only knows create/read/list — got: "${transcript.slice(0, 80)}". Wire a model resolver to go further.` };
});

// ── the gemini resolver: a real model behind the same seam ─────────────────
// The first model-backed provider. Text in, the same { verb, name, content }
// contract out — one generateContent call per turn, structured output, and
// every failure (no key, HTTP error, unparseable or off-contract JSON) is
// `unresolved`, never an invented verb. Zero dependencies: global fetch.
//
// THE MODEL PROPOSES, THE ALLOW-LIST DISPOSES. The verb allow-list comes from
// the ONE command list (lib/commands.mjs) — the same list the live session's
// tool declarations are generated from, so the two paths cannot grow apart.

// GENERATED from the ONE command list — the verb lines are each command's own
// `instruction` field, so the text model's instruction cannot drift from the
// catalogue its schema enumerates (astra's catalogue mutation, 2026-09-20:
// the hand-typed copy listed write/read/list while the schema permitted a
// fourth verb — instruction and schema contradicted each other). The only
// hand-written prose left is the mapping RULES at the bottom, which are about
// the turn, not about any verb.
const RESOLVER_SYSTEM = [
  "You map one spoken turn to one action against a file workspace.",
  "Answer with JSON only, matching the schema. The verbs:",
  ...COMMANDS.map((c) => `- ${c.instruction}`),
  "If the turn maps to none of these, verb = \"unresolved\" and content = one short sentence saying why.",
  "Never use any other verb. When unsure, unresolved.",
].join("\n");

const RESOLVER_SCHEMA = {
  type: "object",
  properties: {
    verb: { type: "string", enum: [...COMMAND_VERBS, "unresolved"] },
    name: { type: "string" },
    content: { type: "string" },
    url: { type: "string" },
    path: { type: "string" },
  },
  required: ["verb"],
};

// Exported for the catalogue-drift test: the instruction is GENERATED, and the
// test proves every command's own line is in it (astra's mutation shape).
export { RESOLVER_SYSTEM };

// Exported so tests can pin the contract with a stubbed fetchImpl and no
// network — the registration below is the same function with real fetch.
export function makeGeminiResolver({
  key = globalThis.process?.env?.GEMINI_API_KEY,
  // Measured 2026-09-19: 3.1-flash-lite corrupts the structured fields
  // ("name":"moon-notes.txt27,872 characters remaining") and 2.5-flash drops
  // content; 3-flash-preview extracts byte-exact content and refuses
  // unsupported verbs honestly.
  model = "models/gemini-3-flash-preview",
  fetchImpl = fetch,
  timeoutMs = 15000,
} = {}) {
  return async (transcript) => {
    if (!key) return { unresolved: "the gemini resolver has no GEMINI_API_KEY" };
    let r;
    try {
      r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: RESOLVER_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: transcript }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: RESOLVER_SCHEMA },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { unresolved: `the gemini resolver could not reach the model: ${e?.message ?? e}` };
    }
    if (!r.ok) return { unresolved: `the model answered HTTP ${r.status}` };
    let text;
    try {
      const body = await r.json();
      text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    } catch {
      return { unresolved: "the model's response envelope was not readable JSON" };
    }
    let action;
    try {
      action = JSON.parse(text);
    } catch {
      return { unresolved: `the model's answer was not JSON: ${text.slice(0, 80)}` };
    }
    // The contract is enforced here, not trusted from the model.
    if (action.verb === "unresolved") {
      return { unresolved: action.content || "the model could not map the turn" };
    }
    if (!COMMAND_VERBS.has(action.verb)) {
      return { unresolved: `the model proposed a verb outside the contract: ${String(action.verb).slice(0, 40)}` };
    }
    if (action.verb === "extension") {
      const { verb, ...args } = action;
      const mapped = commandToAction("call_extension", args);
      return mapped.refused ? { unresolved: mapped.why } : mapped;
    }
    if (!["list", "extensions"].includes(action.verb) && !action.name) {
      return { unresolved: `the model gave no file name for '${action.verb}'` };
    }
    // The coercion class, one door earlier: a write with ABSENT content is not an action
    // with empty content — it is a malformed answer, named here so it never reaches the
    // executor as a file-emptying write (the executor refuses it too, as missing-content).
    if (action.verb === "write" && action.content == null) {
      return { unresolved: "the model answered a write with no content — refused, not emptied: pass content explicitly (an empty string is a valid empty file)" };
    }
    return {
      verb: action.verb,
      name: String(action.name ?? ""),
      ...(action.content != null && { content: String(action.content) }),
    };
  };
}

registerResolver("gemini", makeGeminiResolver());
