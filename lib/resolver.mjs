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
