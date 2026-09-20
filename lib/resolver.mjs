// The provider seam. A resolver turns a transcript into an ACTION:
//   { verb, name, content? }
// The server executes actions; it never parses language itself. Swap the
// resolver to swap the brain — the page and server stay untouched.
//
// Registered today:
//   "script" — a tiny deterministic parser so the loop runs with no model
//              and no key. THIS IS A PLACEHOLDER BRAIN, not the product.
//   Planned: "gemini-live", "openai-realtime" — see docs/00-brief.md. The
//   interface those implement is exactly this function's contract.

const resolvers = {};

export function registerResolver(name, fn) {
  resolvers[name] = fn;
}

export function resolveTurn(transcript, provider = "script") {
  const fn = resolvers[provider];
  if (!fn) return { unresolved: `no resolver registered for '${provider}'` };
  return fn(transcript);
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

  if (/\blist\b/.test(t)) return { verb: "list", name: "" };

  return { unresolved: `the script resolver only knows create/read/list — got: "${transcript.slice(0, 80)}". Wire a model resolver to go further.` };
});
