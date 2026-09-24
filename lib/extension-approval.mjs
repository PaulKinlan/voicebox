// Short-lived host-console authority, bound to one disclosed plan, never the host token.
import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";

export const APPROVAL_TTL_MS = 120_000;
const refuse = (refused, why) => ({ ok: false, refused, why });

export function createExtensionApprovals({ now = Date.now, display = console.log, pendingFile = undefined } = {}) {
  // ponytail: process-local, 32 retained requests; use a shared store only for multi-host approval.
  const requests = new Map();

  function getPendingPath() {
    if (typeof pendingFile === "function") return pendingFile();
    if (typeof pendingFile === "string") return pendingFile;
    return null;
  }

  function writePending(data) {
    const filePath = getPendingPath();
    if (!filePath) return;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      display(`[extension approval warning] Could not write pending approval file: ${err?.message ?? err}`);
    }
  }

  function clearPending() {
    const filePath = getPendingPath();
    if (!filePath) return;
    try {
      rmSync(filePath, { force: true });
    } catch {}
  }

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
      // Write secure 0600 dotfile for host discovery tools (voicebox-beads-62f)
      writePending({ requestId, plan, code, expiresAt });
      // JSON escaping prevents descriptor text from emitting terminal control sequences.
      display(`[extension approval] Review this plan on the host: ${JSON.stringify(plan)}`);
      display(`[extension approval] ${requestId} approve ${JSON.stringify(plan.id)}: ${code} (expires ${new Date(expiresAt).toISOString()}). Enter only if you approve this exact plan. Anyone who can read this console can approve it.`);
      // Security invariant: the code must NEVER be returned in this return value
      return { ok: true, requestId, expiresAt, plan };
    },
    consume(requestId, code, plan) {
      const pending = requests.get(requestId);
      if (!pending) {
        clearPending();
        return refuse("approval-unknown", "No such approval request. Request a new code on the host.");
      }
      if (pending.used) {
        clearPending();
        return refuse("approval-used", "This approval code was already consumed. Request a new code.");
      }
      if (now() >= pending.expiresAt) {
        clearPending();
        return refuse("approval-expired", "This approval code expired. Request a new code on the host.");
      }
      if (++pending.attempts >= 5) {
        pending.used = true;
        clearPending();
      }
      if (typeof code !== "string" || !/^\d{8}$/.test(code) || code !== pending.code) {
        return refuse(pending.used ? "approval-attempts-exhausted" : "approval-code-invalid", "The approval code is incorrect. After five attempts, request a new code.");
      }
      // Consume before checking or acting: a refusal/error must never make a valid code replayable.
      pending.used = true;
      pending.code = null;
      clearPending();
      if (JSON.stringify(plan) !== pending.fingerprint) return refuse("approval-plan-changed", "The extension plan changed. Review it and request a new code.");
      return { ok: true };
    },
    clear() {
      requests.clear();
      clearPending();
    },
  };
}
