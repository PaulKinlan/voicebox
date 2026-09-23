// ACP v1 state/validation, independent of stdio, Node and credential custody.
// The transport delivers decoded JSON messages and reports closure; it must bound framing.
export const ACP_AGENT = Object.freeze({ name: "pi-acp", version: "0.0.33", piVersion: "0.85.1" });
const fail = (refused, why) => Object.assign(new Error(why), { refused });
const bytes = (value) => new TextEncoder().encode(value).length;
/**
 * **The option kinds that can GRANT an effect.** ACP offers denials too
 * (`reject_once`, `reject_always`); a grant that names one of those is not a
 * grant, which is the shape "a permission for a plan is not a permission for
 * whatever the tool finally runs" takes at this seam.
 */
const ALLOW_KINDS = new Set(["allow_once", "allow_always"]);

export function createAcpClient(transport, { timeoutMs = 10000, maxBytes = 65536, decide } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) {
    throw fail("unbounded-executor", "ACP requires finite timeout and message/output bounds");
  }
  if (decide !== undefined && typeof decide !== "function") {
    throw fail("acp-decider-invalid", "the permission decider must be a function when supplied — an authority that cannot be called is not an authority");
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
          /**
           * **Permission requests: the host decides, the client relays.**
           *
           * The client holds no effect authority of its own. With no `decide`
           * supplied it answers `cancelled` — the safe DEFAULT, and the exact
           * behaviour every caller had before a decider existed. That default
           * is not a design statement that nothing may ever be allowed: when a
           * host DOES supply `decide`, the authority is there, the host is
           * asked, and the answer is validated against the options the harness
           * actually offered before anything is granted. An allowance naming an
           * option nobody offered — or a denial kind — is refused here.
           */
          if (message.method === "session/request_permission") {
            void decidePermission(message);
            return;
          }
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "client capability unavailable" } });
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
  /**
   * **What was asked, what was answered, and WHY** — bounded, newest last.
   *
   * The wire's only denial is `cancelled`, and it cannot say whether a person
   * said no or a deadline ran out. That difference is the whole remedy for
   * whoever is waiting, so the reason is kept HERE, in the host's own record,
   * rather than flattened into a field the protocol does not have. The party
   * that holds the transport owns this record and its expiry, because it is
   * the only party that can answer.
   */
  const decidedPermissions = [];
  const PERMISSION_LOG_MAX = 32;
  const remember = (record) => {
    decidedPermissions.push(Object.freeze(record));
    if (decidedPermissions.length > PERMISSION_LOG_MAX) decidedPermissions.shift();
  };
  /** Denial is the safe answer on every path that is not a validated grant. */
  function deny(id, reason, askedAt, asked) {
    if (stopped) return;
    send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
    remember({ id, decision: "cancelled", reason, elapsedMs: Date.now() - askedAt, ...(asked ? { asked } : {}) });
  }
  /**
   * One permission request, decided by the host if there is one.
   *
   * Validation happens BEFORE the host is asked — the request must belong to
   * the active session and offer well-formed, bounded options — and again AFTER:
   * a grant must name an option the harness actually offered, and the option's
   * kind must be one that can grant. Anything else denies, including a decider
   * that throws: a failure to decide is not a decision to allow.
   */
  async function decidePermission(message) {
    const askedAt = Date.now();
    const params = message.params ?? {};
    if (!session || params.sessionId !== session) return deny(message.id, "foreign-session", askedAt);
    const offered = (Array.isArray(params.options) ? params.options : [])
      .filter((o) => o && typeof o.optionId === "string" && o.optionId !== "" && typeof o.kind === "string" && o.kind !== "")
      .slice(0, 16);
    if (offered.length === 0 || offered.some((o) => o.optionId.length > 128 || o.kind.length > 64)) {
      return deny(message.id, "malformed-request", askedAt);
    }
    if (typeof decide !== "function") return deny(message.id, "no-effect-authority", askedAt);
    const asked = Object.freeze({
      sessionId: session,
      title: typeof params.title === "string" ? params.title.slice(0, 256) : null,
      toolCall: params.toolCall && typeof params.toolCall === "object" ? Object.freeze({ ...params.toolCall }) : null,
      options: Object.freeze(offered.map((o) => Object.freeze({ optionId: o.optionId, kind: o.kind }))),
      askedAt,
    });
    let verdict;
    try {
      verdict = await decide(asked);
    } catch (error) {
      verdict = { allow: false, reason: `decider-threw: ${error?.message ?? error}` };
    }
    if (stopped) return;
    const allowed = verdict === true || verdict?.allow === true;
    const named = typeof verdict?.optionId === "string" ? verdict.optionId : null;
    const reason = typeof verdict?.reason === "string" && verdict.reason !== ""
      ? verdict.reason.slice(0, 256)
      : allowed ? "allowed" : "denied";
    if (!allowed) return deny(message.id, reason, askedAt, asked);
    const grant = named === null
      ? offered.find((o) => ALLOW_KINDS.has(o.kind))
      : offered.find((o) => o.optionId === named && ALLOW_KINDS.has(o.kind));
    if (!grant) return deny(message.id, named === null ? "no-allow-option" : "option-not-offered", askedAt, asked);
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: grant.optionId } } });
    // The record carries the ASK it answered — `asked` is the frozen, validated
    // shape the host saw — so an approval can be pinned to what it approved
    // rather than only to the fact that it approved something. `event.input`
    // may differ from what finally runs; this is the half the client holds.
    remember({ id: message.id, decision: "selected", optionId: grant.optionId, reason, elapsedMs: Date.now() - askedAt, asked });
  }

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
    /** The decisions this client relayed, bounded and newest last, each with
     *  the reason the wire cannot carry (a person's no, or an expiry). */
    permissions() { return decidedPermissions.map((record) => ({ ...record })); },
  };
}
