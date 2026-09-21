// ACP v1 state/validation, independent of stdio, Node and credential custody.
// The transport delivers decoded JSON messages and reports closure; it must bound framing.
export const ACP_AGENT = Object.freeze({ name: "pi-acp", version: "0.0.33", piVersion: "0.85.1" });
const fail = (refused, why) => Object.assign(new Error(why), { refused });
const bytes = (value) => new TextEncoder().encode(value).length;

export function createAcpClient(transport, { timeoutMs = 10000, maxBytes = 65536 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) {
    throw fail("unbounded-executor", "ACP requires finite timeout and message/output bounds");
  }
  let next = 0, stopped = null, initialized = false, session = null, prompt = null;
  const pending = new Map();
  function stop(error) {
    if (stopped) return;
    stopped = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
    transport.close();
  }
  function send(message) {
    if (bytes(JSON.stringify(message)) > maxBytes) throw fail("acp-message-over-budget", "ACP message exceeds the configured byte limit");
    transport.send(message);
  }
  transport.onClose((error) => stop(error ?? fail("acp-closed", "ACP transport closed")));
  transport.onMessage((message) => {
    if (stopped) return;
    try {
      if (!message || message.jsonrpc !== "2.0" || bytes(JSON.stringify(message)) > maxBytes) {
        throw fail("acp-invalid-message", "expected a bounded ACP JSON-RPC 2.0 object");
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          // No effect authority is supplied by this answer-only client. Denial never chooses allow.
          send(message.method === "session/request_permission"
            ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "client capability unavailable" } });
        } else if (message.method === "session/update" && prompt) {
          if (message.params?.sessionId !== session) throw fail("acp-session-mismatch", "update does not belong to the active session");
          const update = message.params.update;
          if (update?.sessionUpdate === "agent_message_chunk") {
            if (update.content?.type !== "text" || typeof update.content.text !== "string") throw fail("acp-invalid-update", "answer-only task requires text chunks");
            prompt.text += update.content.text;
            if (bytes(prompt.text) > maxBytes) throw fail("task-output-over-budget", "ACP answer exceeds the admitted output bound");
          }
        }
        return;
      }
      const p = pending.get(message.id);
      if (!p || (Object.hasOwn(message, "result") === Object.hasOwn(message, "error"))) throw fail("acp-invalid-response", "ACP response must match one pending request");
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(fail(message.error.code === -32000 ? "acp-authentication-required" : "acp-request-refused", "the harness refused the ACP request"));
      else p.resolve(message.result);
    } catch (error) { stop(error); }
  });
  function request(method, params) {
    if (stopped) return Promise.reject(stopped);
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(fail("acp-timeout", `ACP ${method} exceeded its deadline`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { stop(error); }
    });
  }
  return {
    async initialize() {
      if (initialized) throw fail("acp-state", "already initialized");
      const info = await request("initialize", { protocolVersion: 1, clientInfo: { name: "voicebox", version: "0.1.0" }, clientCapabilities: {} });
      if (info?.protocolVersion !== 1 || info.agentInfo?.name !== ACP_AGENT.name || info.agentInfo?.version !== ACP_AGENT.version) {
        const error = fail("adapter-version-unsupported", `tested ACP v1 / ${ACP_AGENT.name} ${ACP_AGENT.version} required`);
        stop(error); throw error;
      }
      initialized = true;
      return info;
    },
    async newSession(cwd) {
      if (!initialized || session) throw fail("acp-state", "initialize once before creating one session");
      const result = await request("session/new", { cwd, mcpServers: [] });
      if (typeof result?.sessionId !== "string" || !result.sessionId || result.sessionId.length > 512) {
        const error = fail("acp-invalid-session", "the harness returned no bounded session ID");
        stop(error); throw error;
      }
      session = result.sessionId;
      return session;
    },
    async prompt(text) {
      if (!session || prompt) throw fail("acp-state", "one active prompt in an initialized session is required");
      if (typeof text !== "string" || !text.trim() || bytes(text) > 16384) throw fail("task-input-over-budget", "prompt must contain at most 16384 UTF-8 bytes");
      prompt = { text: "" };
      try {
        const result = await request("session/prompt", { sessionId: session, prompt: [{ type: "text", text }] });
        if (result?.stopReason !== "end_turn") throw fail("acp-turn-incomplete", "the harness did not report end_turn");
        return prompt.text;
      } finally { prompt = null; }
    },
    cancel() {
      if (!prompt || stopped) throw fail("task-not-running", "no running ACP prompt to cancel");
      send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session } });
      // Sending cancellation is not observing termination.
    },
    close() { stop(fail("acp-closed", "ACP client closed")); },
  };
}
