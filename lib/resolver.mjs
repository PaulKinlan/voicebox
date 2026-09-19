// The resolver providers — plugged into the loop (lib/loop.mjs), which owns
// the cycle. A resolver turns a transcript into an ACTION:
//   { verb, name, content? }   or   { unresolved: "why" }
// The server executes actions; no resolver touches the filesystem itself.
// Swap the provider to swap the brain — the page and server stay untouched.
//
// Providers today:
//   "script" — a tiny deterministic parser so the loop runs with no model
//              and no key. THIS IS A PLACEHOLDER BRAIN, not the product.
//   "gemini" — the first model-backed provider: one generateContent call
//              per turn, structured JSON out, same contract. Selected with
//              VOICEBOX_PROVIDER=gemini.
//   Planned: "openai-realtime" — see docs/00-brief.md.

// ── the script resolver: a few verbs, no model ─────────────────────────────
// Parses: "create/write a file called <name> (with|containing) <content>",
//         "read <name>", "list files". Anything else is unresolved — the UI
//         says so instead of pretending.
export function scriptResolver(transcript) {
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
}

// ── the gemini resolver: a real model behind the same seam ─────────────────
// The first model-backed provider. Text in, the same { verb, name, content }
// contract out — one generateContent call per turn, structured output, and
// every failure (no key, HTTP error, unparseable or off-contract JSON) is
// `unresolved`, never an invented verb. Zero dependencies: global fetch.
//
// THE MODEL PROPOSES, THE ALLOW-LIST DISPOSES. The response is validated
// against the contract here — a model answer outside it is `unresolved`,
// and path safety stays where it always was: the executor's containment.
const VERBS = new Set(["write", "read", "list"]);

const RESOLVER_SYSTEM = [
  "You map one spoken turn to one action against a file workspace.",
  "Answer with JSON only, matching the schema. The verbs:",
  "- write: create or overwrite a file. name = the file name (a plain name, no directories), content = the exact text to write.",
  "- read: return a file's contents. name = the file name.",
  "- list: list the workspace's files. name = \"\".",
  "If the turn maps to none of these, verb = \"unresolved\" and content = one short sentence saying why.",
  "Never use any other verb. When unsure, unresolved.",
].join("\n");

const RESOLVER_SCHEMA = {
  type: "object",
  properties: {
    verb: { type: "string", enum: ["write", "read", "list", "unresolved"] },
    name: { type: "string" },
    content: { type: "string" },
  },
  required: ["verb"],
};

// Exported so tests can pin the contract with a stubbed fetchImpl and no
// network — the provider pack below is the same function with real fetch.
export function makeGeminiResolver({
  key = globalThis.process?.env?.GEMINI_API_KEY,
  model = "models/gemini-3.1-flash-lite",
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
    if (!VERBS.has(action.verb)) {
      return { unresolved: `the model proposed a verb outside the contract: ${String(action.verb).slice(0, 40)}` };
    }
    if (action.verb !== "list" && !action.name) {
      return { unresolved: `the model gave no file name for '${action.verb}'` };
    }
    return {
      verb: action.verb,
      name: String(action.name ?? ""),
      ...(action.content != null && { content: String(action.content) }),
    };
  };
}

// The provider pack, extension-shaped: this is how providers plug into the
// loop (loop.use), and the shape every future extension takes (N10/N16).
export function resolverPack(loop) {
  loop.registerResolver("script", scriptResolver);
  loop.registerResolver("gemini", makeGeminiResolver());
}
