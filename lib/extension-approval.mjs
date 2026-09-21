// Short-lived host-console authority, bound to one disclosed plan, never the host token.
import { randomInt, randomUUID } from "node:crypto";

export const APPROVAL_TTL_MS = 120_000;
const refuse = (refused, why) => ({ ok: false, refused, why });

export function createExtensionApprovals({ now = Date.now, display = console.log } = {}) {
  // ponytail: process-local, 32 retained requests; use a shared store only for multi-host approval.
  const requests = new Map();
  return {
    request(plan) {
      const time = now();
      for (const [key, value] of requests) {
        if (time >= value.expiresAt + APPROVAL_TTL_MS) requests.delete(key);
      }
      if (requests.size >= 32) return refuse("approval-rate-limited", "Too many approval requests. Wait up to four minutes before trying again.");
      const requestId = randomUUID();
      const code = String(randomInt(100_000_000)).padStart(8, "0");
      const expiresAt = time + APPROVAL_TTL_MS;
      requests.set(requestId, { fingerprint: JSON.stringify(plan), code, expiresAt, attempts: 0 });
      // JSON escaping prevents descriptor text from emitting terminal control sequences.
      display(`[extension approval] Review this plan on the host: ${JSON.stringify(plan)}`);
      display(`[extension approval] ${requestId} approve ${JSON.stringify(plan.id)}: ${code} (expires ${new Date(expiresAt).toISOString()}). Enter only if you approve this exact plan. Anyone who can read this console can approve it.`);
      return { ok: true, requestId, expiresAt, plan };
    },
    consume(requestId, code, plan) {
      const pending = requests.get(requestId);
      if (!pending) return refuse("approval-unknown", "No such approval request. Request a new code on the host.");
      if (pending.used) return refuse("approval-used", "This approval code was already consumed. Request a new code.");
      if (now() >= pending.expiresAt) return refuse("approval-expired", "This approval code expired. Request a new code on the host.");
      if (++pending.attempts >= 5) pending.used = true;
      if (typeof code !== "string" || !/^\d{8}$/.test(code) || code !== pending.code) {
        return refuse(pending.used ? "approval-attempts-exhausted" : "approval-code-invalid", "The approval code is incorrect. After five attempts, request a new code.");
      }
      // Consume before checking or acting: a refusal/error must never make a valid code replayable.
      pending.used = true;
      pending.code = null;
      if (JSON.stringify(plan) !== pending.fingerprint) return refuse("approval-plan-changed", "The extension plan changed. Review it and request a new code.");
      return { ok: true };
    },
  };
}
