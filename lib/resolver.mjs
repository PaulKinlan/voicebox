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
export function script(transcript) {
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

  // ── proposing / installing / creating an extension via speech or typed turn ──
  const extInstall =
    t.match(/^(?:install|load|enable|stage|add)\s+(?:the\s+)?(?:catalogue\s+)?extension\s+(?:(?:called|named)\s+)?["']?([a-z0-9_-]+)["']?$/i) ||
    t.match(/^(?:install|load|enable|stage|add)\s+(?:the\s+)?["']?([a-z0-9_-]+)["']?\s+extension$/i) ||
    t.match(/^propose\s+(?:the\s+)?(?:catalogue\s+)?extension\s+(?:(?:called|named)\s+)?["']?([a-z0-9_-]+)["']?$/i);
  if (extInstall) {
    const id = extInstall[1];
    return { verb: "propose_extension", name: id, args: { catalogueId: id } };
  }

  const extCreate = t.match(/^(?:create|propose|make|build)\s+(?:an?\s+)?extension\s+(?:(?:called|named)\s+)?["']?([a-z0-9_-]+)["']?\s+(.+)$/i);
  if (extCreate) {
    const [, id, rest] = extCreate;
    const extRead = rest.match(/^(?:that|to|which)?\s*reads?(?:\s+(?:from\s+)?(?:file\s+)?)?["']?([\w./-]+)["']?$/i);
    if (extRead) {
      return { verb: "propose_extension", name: id, args: { id, name: id, primitive: "read-file", defaultPath: extRead[1] } };
    }
    const extWrite = rest.match(/^(?:that|to|which)?\s*writes?(?:\s+(?:to\s+)?(?:file\s+)?)?["']?([\w./-]+)["']?$/i);
    if (extWrite) {
      return { verb: "propose_extension", name: id, args: { id, name: id, primitive: "write-file", defaultPath: extWrite[1] } };
    }
    const extUrl = rest.match(/^(?:(?:that|to|which)\s+)?(?:fetches|fetch|gets|get|queries|query|calls|call|for)\s+(?:from\s+)?["']?(https?:\/\/[^\s"']+)["']?$/i);
    if (extUrl) {
      const defaultUrl = extUrl[1];
      let host = "";
      try {
        host = new URL(defaultUrl).hostname;
      } catch {
        host = defaultUrl.replace(/^https?:\/\//i, "").split("/")[0];
      }
      return { verb: "propose_extension", name: id, args: { id, name: id, primitive: "http-get", host, defaultUrl } };
    }
    const extHost = rest.match(/^(?:(?:that|to|which)\s+)?(?:fetches|fetch|gets|get|queries|query|calls|call|for)\s+(?:from\s+|host\s+)?["']?([a-z0-9.-]+\.[a-z]{2,})["']?$/i);
    if (extHost) {
      const host = extHost[1];
      const defaultUrl = `https://${host}`;
      return { verb: "propose_extension", name: id, args: { id, name: id, primitive: "http-get", host, defaultUrl } };
    }
  }

  // ── calling an ADMITTED tool ──────────────────────────────────────────
  const toolCall = t.match(/^(?:run|call|use) the tool ([a-z0-9_-]+)(?:\s+(.*))?$/);
  if (toolCall) return { verb: "tool", name: toolCall[1], args: toolCall[2] ? { url: toolCall[2] } : {} };

  if (/^(?:undo|revert)(?:\s+(?:last|that)(?:\s+(?:action|change|edit|write|delete|file))?)?$/i.test(t.trim())) {
    return { verb: "undo", name: "" };
  }

  const write = t.match(/(?:create|write|make)\s+(?:a\s+)?(?:file\s+)?(?:called\s+)?["']?([\w./-]+)["']?\s*(?:with|containing)?\s*(.*)/);
  if (write) {
    const [, name, rest] = write;
    const content = rest.replace(/^(with|containing)\s+/, "").replace(/^["']|["']$/g, "");
    return { verb: "write", name, content };
  }

  const read = t.match(/^read\s+["']?([\w./-]+)["']?$/);
  if (read) return { verb: "read", name: read[1] };

  const del = t.match(/^(?:delete|remove|rm)\s+(?:file\s+)?["']?([\w./-]+)["']?$/);
  if (del) return { verb: "delete", name: del[1] };

  const edit = t.match(/^edit\s+["']?([\w./-]+)["']?\s+replace\s+["'](.*?)["']\s+with\s+["'](.*?)["']$/s);
  if (edit) return { verb: "edit", name: edit[1], oldText: edit[2], newText: edit[3] };

  const diff = t.match(/^diff\s+["']?([\w./-]+)["']?\s+(?:with|containing)\s*(.*)/s);
  if (diff) {
    const [, name, rest] = diff;
    const content = rest.replace(/^(with|containing)\s+/, "").replace(/^["']|["']$/g, "");
    return { verb: "diff", name, content };
  }

  // WEB SEARCH before grep: "search the web for X" is more specific than "search for X"
  // and must win, or the grep rule eats it (found by driving: the grep rule captured
  // 'the web for X' as a grep query before the web-search rule could fire).
  const webSearch = t.match(/^(?:web\s+search|search\s+the\s+web)\s+(?:for\s+)?["']?(.+?)["']?$/i);
  if (webSearch) return { verb: "extension", name: "web_search", args: { query: webSearch[1].trim() } };
  const wsVerb = t.match(/^web_search\s+["']?(.+?)["']?$/i);
  if (wsVerb) return { verb: "extension", name: "web_search", args: { query: wsVerb[1].trim() } };

  const grep = t.match(/^(?:grep|search)(?:\s+for)?\s+["']?(.*?)["']?$/);
  if (grep && grep[1].trim()) return { verb: "grep", query: grep[1].trim() };

  if (/\blist\b.*\bagents\b/.test(t) || /\bshow\b.*\bagents\b/.test(t)) return { verb: "list_agents", name: "" };

  const ask = t.match(/^(?:ask|tell)\s+([a-zA-Z0-9_./:-]+)\s+to\s+(.*)/i);
  if (ask) return { verb: "delegate_task", agent: ask[1], task: ask[2] };

  const delg = t.match(/^delegate\s+(?:task\s+)?["']?(.*?)["']?\s+to\s+([a-zA-Z0-9_./:-]+)$/i);
  if (delg) return { verb: "delegate_task", agent: delg[2], task: delg[1] };

  const delg2 = t.match(/^delegate\s+to\s+([a-zA-Z0-9_./:-]+)[:\s]+(.*)/i);
  if (delg2) return { verb: "delegate_task", agent: delg2[1], task: delg2[2] };

  const contact = transcript.match(/^contact\s+([a-zA-Z0-9_./:-]+)\s+(?:with\s+)?(.*)/is);
  if (contact) return { verb: "contact_agent", target: contact[1], message: contact[2] };

  const launchApp = transcript.match(/^launch\s+(?:mini[- ]app|app)\s+(?:["']([^"']+)["']|([a-zA-Z0-9_.-]+))\s+with\s+(.*)/is);
  if (launchApp) return { verb: "mini_app", title: launchApp[1] || launchApp[2], html: launchApp[3] };

  if (/^git\s+status\b/i.test(t) || /\b(check|show|get)\b.*\bgit\s+status\b/i.test(t) || /\b(repo|repository)\s+status\b/i.test(t)) {
    return { verb: "git_status", name: "" };
  }
  const gitDiffMatch = t.match(/^git\s+diff(?:\s+--(staged|cached))?(?:\s+(?:--\s+)?([^\s]+))?/i);
  if (gitDiffMatch) {
    const staged = Boolean(gitDiffMatch[1] || /\bstaged\b|\bcached\b/i.test(t));
    const file = gitDiffMatch[2] ? gitDiffMatch[2].replace(/^["']|["']$/g, "") : undefined;
    return { verb: "git_diff", name: "", staged, ...(file && { file }) };
  }
  if (/^git\s+diff\b/i.test(t) || /\b(check|show|get)\b.*\bgit\s+diff\b/i.test(t)) {
    return { verb: "git_diff", name: "" };
  }
  if (/^git\s+log\b/i.test(t) || /\b(check|show|get)\b.*\bgit\s+log\b/i.test(t) || /\b(commit\s+history|recent\s+commits)\b/i.test(t)) {
    return { verb: "git_log", name: "" };
  }
  if (/^inspect\s+environment\b/i.test(t) || /\b(environment\s+info|probe\s+environment|check\s+environment|host\s+environment)\b/i.test(t)) {
    return { verb: "inspect_environment", name: "" };
  }

  if (/\blist\b.*\bextensions\b/.test(t)) return { verb: "extensions", name: "" };
  if (/\blist\b/.test(t)) return { verb: "list", name: "" };

  return { unresolved: `the script resolver only knows create/read/list/delete/edit/diff/undo/grep/list_agents/delegate_task/contact_agent/launch_mini_app/git_status/git_diff/git_log/inspect_environment/propose_extension — got: "${transcript.slice(0, 80)}". Wire a model resolver to go further.` };
}

registerResolver("script", script);

// ── the model-backed resolvers: real models behind the same seam ───────────
// Text in, the same { verb, name, content } contract out — structured output,
// and every failure (no key, HTTP error, unparseable or off-contract JSON) is
// `unresolved`, never an invented verb. Zero dependencies: global fetch.
//
// THE MODEL PROPOSES, THE ALLOW-LIST DISPOSES. The verb allow-list comes from
// the ONE command list (lib/commands.mjs) — the same list the live session's
// tool declarations are generated from, so the two paths cannot grow apart.

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
    oldText: { type: "string" },
    newText: { type: "string" },
    query: { type: "string" },
    agent: { type: "string" },
    task: { type: "string" },
    target: { type: "string" },
    message: { type: "string" },
    title: { type: "string" },
    html: { type: "string" },
    url: { type: "string" },
    path: { type: "string" },
    id: { type: "string" },
    catalogueId: { type: "string" },
    description: { type: "string" },
    primitive: { type: "string" },
    toolName: { type: "string" },
    host: { type: "string" },
    defaultUrl: { type: "string" },
    defaultPath: { type: "string" },
  },
  required: ["verb"],
};

// Exported for the catalogue-drift test: the instruction is GENERATED, and the
// test proves every command's own line is in it (astra's catalogue mutation).
export { RESOLVER_SYSTEM };

export function validateModelAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { unresolved: `the model's answer was not a JSON object: ${String(action ?? "").slice(0, 80)}` };
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
  if (action.verb === "propose_extension") {
    const { verb, ...args } = action;
    const mapped = commandToAction("propose_extension", args);
    return mapped.refused ? { unresolved: mapped.why } : mapped;
  }
  if (action.verb === "list_agents") {
    return { verb: "list_agents", name: "" };
  }
  if (action.verb === "undo") {
    return { verb: "undo", name: "" };
  }
  if (action.verb === "delegate_task") {
    if (!action.task || !String(action.task).trim()) {
      return { unresolved: "the model gave no task description for 'delegate_task'" };
    }
    return { verb: "delegate_task", agent: String(action.agent ?? "default"), task: String(action.task) };
  }
  if (!["list", "extensions", "grep", "list_agents", "delegate_task", "undo", "git_status", "git_diff", "git_log", "inspect_environment", "contact_agent", "mini_app"].includes(action.verb) && !action.name) {
    return { unresolved: `the model gave no file name for '${action.verb}'` };
  }
  if (action.verb === "write" && action.content == null) {
    return { unresolved: "the model answered a write with no content — refused, not emptied: pass content explicitly (an empty string is a valid empty file)" };
  }
  if (action.verb === "edit" && (action.oldText == null || action.newText == null)) {
    return { unresolved: "the model answered an edit without 'oldText' or 'newText' — pass both explicitly" };
  }
  if (action.verb === "diff" && action.content == null) {
    return { unresolved: "the model answered a diff with no content — pass proposed content explicitly" };
  }
  if (action.verb === "grep" && (action.query == null || !String(action.query).trim())) {
    return { unresolved: "the model answered a grep with no query — pass query explicitly" };
  }
  return {
    verb: action.verb,
    name: String(action.name ?? ""),
    ...(action.content != null && { content: String(action.content) }),
    ...(action.oldText != null && { oldText: String(action.oldText) }),
    ...(action.newText != null && { newText: String(action.newText) }),
    ...(action.query != null && { query: String(action.query) }),
    ...(action.agent != null && { agent: String(action.agent) }),
    ...(action.task != null && { task: String(action.task) }),
    ...(action.target != null && { target: String(action.target) }),
    ...(action.message != null && { message: String(action.message) }),
    ...(action.title != null && { title: String(action.title) }),
    ...(action.html != null && { html: String(action.html) }),
  };
}

function validateModelAnswerText(rawText) {
  const cleaned = String(rawText ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let action;
  try {
    action = JSON.parse(cleaned);
  } catch {
    return { unresolved: `the model's answer was not JSON: ${String(rawText ?? "").slice(0, 80)}` };
  }
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { unresolved: `the model's answer was not a JSON object: ${String(rawText ?? "").slice(0, 80)}` };
  }
  return validateModelAction(action);
}

// Exported so tests can pin the contract with a stubbed fetchImpl and no
// network — the registration below is the same function with real fetch.
export function makeGeminiResolver({
  key = globalThis.process?.env?.GEMINI_API_KEY,
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
    return validateModelAnswerText(text);
  };
}

export function makeOpenAIResolver({
  key = globalThis.process?.env?.OPENAI_API_KEY,
  model = "gpt-4.1-mini",
  fetchImpl = fetch,
  timeoutMs = 15000,
} = {}) {
  return async (transcript) => {
    if (!key) return { unresolved: "the openai resolver has no OPENAI_API_KEY" };
    let r;
    try {
      r = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: RESOLVER_SYSTEM },
            { role: "user", content: transcript },
          ],
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { unresolved: `the openai resolver could not reach the model: ${e?.message ?? e}` };
    }
    if (!r.ok) return { unresolved: `the model answered HTTP ${r.status}` };
    let text;
    try {
      const body = await r.json();
      text = body.choices?.[0]?.message?.content ?? "";
    } catch {
      return { unresolved: "the model's response envelope was not readable JSON" };
    }
    return validateModelAnswerText(text);
  };
}

export function makeClaudeResolver({
  key = globalThis.process?.env?.ANTHROPIC_API_KEY,
  model = "claude-haiku-4-5",
  fetchImpl = fetch,
  timeoutMs = 15000,
} = {}) {
  return async (transcript) => {
    if (!key) return { unresolved: "the claude resolver has no ANTHROPIC_API_KEY" };
    let r;
    try {
      r = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: RESOLVER_SYSTEM,
          messages: [{ role: "user", content: transcript }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { unresolved: `the claude resolver could not reach the model: ${e?.message ?? e}` };
    }
    if (!r.ok) return { unresolved: `the model answered HTTP ${r.status}` };
    let text;
    try {
      const body = await r.json();
      text = (body.content ?? []).map((p) => p.text ?? "").join("");
    } catch {
      return { unresolved: "the model's response envelope was not readable JSON" };
    }
    return validateModelAnswerText(text);
  };
}

registerResolver("gemini", makeGeminiResolver());
registerResolver("openai", makeOpenAIResolver());
registerResolver("claude", makeClaudeResolver());
