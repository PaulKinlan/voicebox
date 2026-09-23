// lib/permission-policy.mjs — D5: Permission policy & unattended escalation protection (voicebox-beads-kei).
//
// THE CORE INVARIANT (no unattended escalation):
// When a delegate requests permission (ACP session/request_permission), the request becomes a
// pending record. The host environment waits for an attendee to decide (allow or deny).
// If nobody attends before the deadline (unattended, timeout elapsed) or if the attendee
// disappears (client disconnect), the policy AUTOMATICALLY DENIES by expiry.
//
// An unattended request can NEVER escalate into a yes.
//
// The denial reaches the delegate over the wire as { outcome: { outcome: "cancelled" } }
// carrying provenance ("unattended-expired" or "unattended-client-disconnected").
//
// COMPLETION RACES CANCELLATION (Edge 2):
// A late Stop or cancellation request arriving after a terminal outcome has been observed
// cannot overwrite that outcome. A completed task stays completed.

import { randomBytes } from "node:crypto";

export const DEFAULT_PERMISSION_TIMEOUT_MS = 10000;

export function createPermissionPolicy({
  timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS,
  now = Date.now,
  onPending,
  onSettled,
} = {}) {
  const pendingRequests = new Map(); // requestId -> record
  const historyRecords = [];
  const HISTORY_MAX = 32;

  function remember(record) {
    historyRecords.push(Object.freeze({ ...record }));
    if (historyRecords.length > HISTORY_MAX) historyRecords.shift();
  }

  /**
   * The decider function passed to createAcpClient(transport, { decide }).
   * Called when the delegate issues `session/request_permission`.
   */
  function decide(asked) {
    const askedAt = asked.askedAt ?? now();
    const requestId = `perm_${randomBytes(8).toString("hex")}`;
    const expiresAt = askedAt + timeoutMs;

    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    let timer = null;
    const record = {
      requestId,
      sessionId: asked.sessionId,
      title: asked.title,
      toolCall: asked.toolCall,
      options: asked.options,
      askedAt,
      expiresAt,
      state: "pending", // "pending" | "allowed" | "denied" | "expired" | "cancelled"
      decision: null,
      reason: null,
      elapsedMs: null,
      _timer: null,
      _resolve: null,
    };

    // EDGE 1: Deny-by-expiry if unattended
    timer = setTimeout(() => {
      if (record.state !== "pending") return;
      const elapsedMs = now() - askedAt;
      record.state = "expired";
      record.decision = false;
      record.reason = "unattended-expired";
      record.elapsedMs = elapsedMs;
      pendingRequests.delete(requestId);
      remember(record);
      onSettled?.(record);
      resolvePromise({
        allow: false,
        reason: "unattended-expired",
        why: `permission request expired after ${timeoutMs}ms without attendance; unattended requests deny by policy`,
      });
    }, Math.max(1, expiresAt - now()));

    record._timer = timer;
    record._resolve = resolvePromise;
    pendingRequests.set(requestId, record);

    onPending?.(record);
    return promise;
  }

  return {
    decide,

    /** Active pending requests, newest last. */
    pending() {
      return Array.from(pendingRequests.values()).map((r) => ({
        requestId: r.requestId,
        sessionId: r.sessionId,
        title: r.title,
        toolCall: r.toolCall,
        options: r.options,
        askedAt: r.askedAt,
        expiresAt: r.expiresAt,
        state: r.state,
      }));
    },

    /** Explicit human resolution of a pending request before its deadline. */
    resolve(requestId, { allow, optionId, reason } = {}) {
      const record = pendingRequests.get(requestId);
      if (!record || record.state !== "pending") {
        return {
          ok: false,
          refused: "permission-already-settled",
          why: record ? `request is already ${record.state}` : `no pending request '${requestId}'`,
        };
      }
      clearTimeout(record._timer);
      const elapsedMs = now() - record.askedAt;
      const allowed = Boolean(allow);
      record.state = allowed ? "allowed" : "denied";
      record.decision = allowed;
      record.reason = reason ?? (allowed ? "person-allowed" : "person-denied");
      record.elapsedMs = elapsedMs;
      pendingRequests.delete(requestId);
      remember(record);
      onSettled?.(record);

      record._resolve({
        allow: allowed,
        optionId,
        reason: record.reason,
      });
      return { ok: true, requestId, state: record.state, reason: record.reason };
    },

    /** Disappearance of an attendee / browser disconnect cancels all pending requests as unattended denials. */
    disconnect(sessionId = null) {
      let count = 0;
      for (const [id, record] of Array.from(pendingRequests.entries())) {
        if (!sessionId || record.sessionId === sessionId) {
          clearTimeout(record._timer);
          const elapsedMs = now() - record.askedAt;
          record.state = "cancelled";
          record.decision = false;
          record.reason = "unattended-client-disconnected";
          record.elapsedMs = elapsedMs;
          pendingRequests.delete(id);
          remember(record);
          onSettled?.(record);
          record._resolve({
            allow: false,
            reason: "unattended-client-disconnected",
            why: "the attendee client disconnected while the request was pending; unattended requests deny by policy",
          });
          count++;
        }
      }
      return { ok: true, cancelled: count };
    },

    /** Bounded decision history. */
    history() {
      return [...historyRecords];
    },
  };
}
