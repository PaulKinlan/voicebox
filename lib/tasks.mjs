// D1: environment-owned admission and audit-backed readback. No ACP client or CLI loader.
// A trusted host may install an executor implementation (D2); request/descriptor data cannot.
// Tests install a closed, no-effects fixture. That proves lifecycle, NOT agent containment.
import { TaskInterrupted } from "./task-interrupted.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { auditFileName, nextSeq, parseEntry, resumeSeq, serializeEntry } from "../core/audit.ts";
import { reduceTask, taskBounds, taskInput, taskTerminal, taskView } from "../core/tasks.ts";

let installedExecutor = null;
export function installTaskExecutor(executor) { installedExecutor = executor; }
export const TASK_TOOLS = new Set(["delegate_task", "task_status"]);
const refusal = (refused, why) => ({ ok: false, refused, why });
const fail = (refused, why) => { throw Object.assign(new Error(why), { refused }); };

// Generic file tools cannot expose or rewrite private task events through the raw audit.
// Check the physical target as well as the name (including a new file under a symlink).
export function protectedAuditPath(root, candidate) {
  const reserved = path.join(fs.realpathSync(root), ".audit");
  const inside = (p) => p === reserved || p.startsWith(`${reserved}${path.sep}`);
  if (inside(path.resolve(candidate))) return true;
  try { return inside(fs.realpathSync(candidate)); }
  catch (err) {
    if (err.code !== "ENOENT") throw err;
    return inside(fs.realpathSync(path.dirname(candidate)));
  }
}

/** An address authenticates its root locator, not its holder. Every read still checks the owner.
 * The existing host token seals locators; replacing that token invalidates these addresses.
 * No root/task index or second database: records remain in the named root's existing audit. */
export function createTaskHost({ environment, instance, boot, addressKey, root, executor = () => installedExecutor, agentRegistry = null, onUpdate = null }) {
  const activeRuns = new Map();
  const latestProgress = new Map(); // address -> the executor's latest coalesced note
  const pid = process.pid;
  const seal = (payload, owner) => createHmac("sha256", addressKey).update(payload).update("\0").update(owner).digest("hex");

  function locate(address, owner) {
    if (typeof address !== "string" || address.length > 8192) fail("invalid-task-address", "a task address is a bounded string");
    const match = /^task_([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(address);
    if (!match) fail("invalid-task-address", "the task address is malformed");
    // Check ownership BEFORE touching the named root. The locator reveals no owner identifier.
    if (!timingSafeEqual(Buffer.from(seal(match[1], owner), "hex"), Buffer.from(match[2], "hex"))) fail("task-owner-mismatch", "the address is not valid for this authenticated owner and host credential epoch");
    let loc;
    try { loc = JSON.parse(Buffer.from(match[1], "base64url")); } catch { fail("invalid-task-address", "the task locator is not readable"); }
    if (loc.environment !== environment) fail("task-environment-changed", "this task belongs to a different environment identity");
    if (loc.instance !== instance || !path.isAbsolute(loc.path)) fail("invalid-task-address", "the task locator does not name this writer and an absolute root");
    checkRoot(loc);
    return loc;
  }

  function checkRoot(loc) {
    let stat;
    try { stat = fs.statSync(loc.path, { bigint: true }); } catch { fail("task-root-unavailable", "the task's original root is not available; the active root is not a substitute"); }
    if (!stat.isDirectory() || fs.realpathSync(loc.path) !== loc.path || String(stat.dev) !== loc.dev || String(stat.ino) !== loc.ino) fail("task-root-replaced", "the directory at the task's root address is no longer the admitted root");
  }

  function auditFile(loc) {
    const dir = path.join(loc.path, ".audit");
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) fail("task-audit-unavailable", "the audit directory is a symlink");
    const file = path.join(dir, auditFileName(instance, `machine:${loc.path}`));
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail("task-audit-unavailable", "the audit file is a symlink");
    return file;
  }

  function read(loc) {
    checkRoot(loc);
    let text;
    let fd;
    try {
      fd = fs.openSync(auditFile(loc), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile()) throw new Error("not a regular audit file");
      text = fs.readFileSync(fd, "utf8");
      // A prior append may have written bytes but failed its flush. Do not bless those
      // bytes as a durable terminal outcome merely because a later read can see them.
      fs.fsyncSync(fd);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      fail("task-audit-unavailable", "the original root's audit cannot be durably read");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    const entries = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = parseEntry(line);
      // Fail closed, not 'no records'. Torn-log repair belongs to D7.
      if (!entry || !Number.isSafeInteger(entry.seq)) fail("task-audit-unavailable", "the audit contains an unreadable entry; no task is replayed");
      entries.push(entry);
    }
    return entries;
  }

  function append(loc, event, project, callId) {
    const entries = read(loc);
    resumeSeq(entries, instance);
    const entry = {
      kind: "task", seq: nextSeq(), instance, project,
      root: `machine:${loc.path}`, turn: callId, at: new Date().toISOString(), task: event,
    };
    // Validate before persisting, including terminal fencing and writer/root pinning.
    reduceTask([...entries, entry], event.address);
    const file = auditFile(loc);
    let fd;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, `${serializeEntry(entry)}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      // Persist new file/directory names too, not just their contents.
      for (const dir of [path.dirname(file), loc.path]) {
        fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      }
      const reread = read(loc).find((e) => e.seq === entry.seq && e.instance === instance);
      if (serializeEntry(reread) !== serializeEntry(entry)) throw new Error("readback mismatch");
    } catch {
      fail("task-persistence-failed", "the task event was not durably confirmed; execution is not authorised");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return reduceTask([...entries, entry], event.address);
  }

  function recordAt(loc, address, owner) {
    let record;
    try { record = reduceTask(read(loc), address); }
    catch (err) { if (err.refused) throw err; fail("task-audit-unavailable", "the task history is inconsistent; no task is replayed"); }
    if (!record) fail("task-not-found", "the named root has no such task record");
    if (record.owner !== owner) fail("task-owner-mismatch", "this authenticated owner did not admit that task; its address grants no access");
    if (record.environment !== environment) fail("task-environment-changed", "the task record belongs to a different environment");
    if (!taskTerminal(record.state) && !activeRuns.has(address)) {
      if (record.boot !== boot) {
        // A different generation alone does not prove death: another process may still own it.
        try { process.kill(record.pid, 0); fail("task-owner-unconfirmed", "the prior process may still be alive; no recovery or replay was attempted"); }
        catch (err) { if (err.code !== "ESRCH") throw err; }
      }
      record = append(loc, { address, state: "interrupted", reason: record.boot === boot ? "admission-unconfirmed" : "environment-ended-outcome-unknown" }, record.project, record.callId);
    }
    return record;
  }

  function settle(loc, record, event) {
    const settled = append(loc, { address: record.address, ...event }, record.project, record.callId);
    try { onUpdate?.(taskView(settled)); } catch {}
    return settled;
  }

  /** D6 cancellation honesty: request, abort, bounded wait, then UNKNOWN — never a fabricated cancel. */
  async function cancelTask(loc, address, owner, graceMs = 2000) {
    const record = recordAt(loc, address, owner);
    if (taskTerminal(record.state)) fail("task-not-running", `the task is already ${record.state}; cancel applies to a running task`);
    if (!activeRuns.has(address)) {
      const r = append(loc, { address, state: "cancel_unconfirmed", reason: "no live runner in this process holds the task; whether the work stopped is unknown" }, record.project, record.callId);
      return { ok: true, state: r.state, observed: false };
    }
    append(loc, { address, state: "cancel_requested", reason: "the person asked to stop" }, record.project, record.callId);
    const running = activeRuns.get(address);
    running.controller.abort(Object.assign(new Error("the person asked to stop this task"), { refused: "task-cancelled" }));
    const t0 = Date.now();
    while (Date.now() - t0 < graceMs) {
      const cur = reduceTask(read(loc), address);
      if (taskTerminal(cur.state)) return { ok: true, state: cur.state, observed: true };
      await new Promise((r) => setTimeout(r, 50));
    }
    const r = append(loc, { address, state: "cancel_unconfirmed", reason: `the executor did not observe cancellation within ${graceMs}ms; whether the work stopped is unknown and capacity remains charged` }, record.project, record.callId);
    return { ok: true, state: r.state, observed: false };
  }

  /** Coalesced progress: the executor's latest note per run, read at a safe boundary (status), audited only at settle. */
  function progressFor(address, owner) {
    locate(address, owner);
    const record = reduceTask(read(loc), address);
    if (taskTerminal(record.state)) return { note: record.progress ?? null, final: true };
    return { note: latestProgress.get(address) ?? null, final: false };
  }

  async function run(loc, record, implementation) {
    const running = activeRuns.get(record.address);
    if (!running) return;
    let execution;
    try {
      record = append(loc, { address: record.address, state: "running" }, record.project, record.callId);
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          running.controller.abort();
          reject(Object.assign(new Error("task deadline elapsed"), { refused: "task-deadline" }));
        }, record.bounds.deadlineMs);
      });
      let answer;
      const input = Object.freeze({ ...record.input, context: Object.freeze([...record.input.context]) });
      const bounds = Object.freeze({ ...record.bounds });
      // D6 progress: the executor reports its own coalesced note; the host keeps the LATEST
      // (repeats of a stage overwrite), never invents a percentage, and audits it only at settle.
      const report = (note) => {
        if (typeof note !== "string" || !note.trim()) return;
        latestProgress.set(record.address, note.slice(0, 300));
      };
      try {
        execution = Promise.resolve().then(() => implementation.run({
          input,
          bounds,
          signal: running.controller.signal,
          report,
          root: record.root,
          agentConfig: record.agentConfig ?? null,
          harness: record.harness ?? record.input.agent,
        }));
        answer = await Promise.race([execution, deadline]);
      } finally { clearTimeout(timer); }
      if (typeof answer !== "string") fail("task-invalid-result", "the executor did not return text");
      if (Buffer.byteLength(answer) > record.bounds.maxOutputBytes) fail("task-output-over-budget", "the executor result exceeded the admitted output bound");
      settle(loc, record, { state: "completed", answer, progress: latestProgress.get(record.address) ?? null });
    } catch (err) {
      // D6 owns public Stop/cancel escalation. A deadline is not proof that a subprocess stopped,
      // and a person's cancel is not "interrupted": it is named, and its outcome is observed.
      const state = err?.refused === "task-cancelled" ? "cancelled"
        : err instanceof TaskInterrupted || err.refused === "task-deadline" ? "interrupted" : "failed";
      try {
        settle(loc, record, {
          state,
          reason: err.refused ?? "executor-failed",
          ...(typeof answer === "string" && answer ? { partial: answer } : {}), // D6: partial output is recorded, never discarded
          progress: latestProgress.get(record.address) ?? null,
        });
      } catch { /* Keep the durable prior state. Readback reports unconfirmed, never fabricated success. */ }
    } finally {
      latestProgress.delete(record.address);
      // A timed-out executor may still be alive. Keep its capacity charged until it
      // actually settles; reporting interrupted is not permission to over-admit.
      const release = () => { activeRuns.delete(record.address); };
      if (execution) void execution.then(release, release);
      else release();
    }
  }

  function admit(args, authority) {
    const parsed = taskInput(args);
    if (!parsed.ok) return parsed;
    Object.freeze(parsed.value.context);
    Object.freeze(parsed.value);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(authority.callId ?? "")) return refusal("task-call-id-required", "the authenticated transport must provide a stable call id, outside model arguments");
    const selected = root();
    if (!selected || selected.root.kind !== "machine" || selected.root.environment !== environment) return refusal("task-root-unavailable", "D1 requires this host's explicitly declared machine root; foreign and page roots are not adopted");
    let canonical, stat;
    try { canonical = fs.realpathSync(selected.root.path); stat = fs.statSync(canonical, { bigint: true }); }
    catch { return refusal("task-root-unavailable", "the declared task root is no longer available"); }
    const loc = { environment, instance, path: canonical, dev: String(stat.dev), ino: String(stat.ino), id: randomBytes(16).toString("hex") };
    const entries = read(loc);
    const previous = entries.find((e) => e.kind === "task" && e.task?.created?.owner === authority.owner && e.task.created.callId === authority.callId);
    if (previous) {
      const record = recordAt(locate(previous.task.address, authority.owner), previous.task.address, authority.owner);
      if (JSON.stringify(record.input) !== JSON.stringify(parsed.value)) return refusal("task-call-id-conflict", "that call id already admitted different task content");
      return { ok: true, task: taskView(record), existing: true };
    }
    if (activeRuns.size >= 8) return refusal("task-capacity-exhausted", "this environment already owns eight active tasks; existing handles remain readable");
    let configuredAgent = null;
    if (agentRegistry) {
      configuredAgent = agentRegistry.get(parsed.value.agent);
      if (!configuredAgent) {
        configuredAgent = agentRegistry.getDefault(environment, parsed.value.agent);
      }
      if (configuredAgent) {
        if (configuredAgent.environmentKey && configuredAgent.environmentKey !== environment) {
          return refusal("agent-environment-mismatch", `Configured agent '${configuredAgent.id}' belongs to environment '${configuredAgent.environmentKey}', not '${environment}'.`);
        }
        if (configuredAgent.transport === "stdio" && (environment === "browser" || selected.root?.kind === "opfs")) {
          return refusal("unsupported-runtime-capability", "A browser runtime cannot spawn a stdio CLI; use an in-process or web-worker adapter instead.");
        }
      }
    }
    const implementation = executor();
    if (!implementation) return refusal("executor-unavailable", `no admitted task executor for '${parsed.value.agent}'; D2 is not implemented`);
    if (typeof implementation.check !== "function" || typeof implementation.run !== "function") return refusal("unbounded-executor", `no host-enforced executor for '${parsed.value.agent}'; descriptor metadata and CLI configuration are not a boundary`);
    const checkArgs = {
      input: parsed.value,
      root: Object.freeze({ ...selected.root }),
      environment,
      harness: configuredAgent?.harness ?? parsed.value.agent,
      agentConfig: configuredAgent,
      ...(configuredAgent?.bounds ? { bounds: { ...configuredAgent.bounds } } : {}),
    };
    const checked = implementation.check(checkArgs);
    if (checked && typeof checked.then === "function") {
      // Refusal is already the outcome; observe a rejected asynchronous check without admitting it.
      void Promise.resolve(checked).catch(() => {});
      return refusal("unbounded-executor", "task admission requires a synchronous host boundary check");
    }
    if (!checked) return refusal("unbounded-executor", "the host check did not establish an executor boundary");
    if (checked.ok !== true) return { ok: false, refused: checked.refused ?? "unbounded-executor", why: checked.why ?? "the host could not establish the executor boundary" };
    if (agentRegistry && !configuredAgent && !checked.mechanism?.includes("closed-host-fixture")) {
      return refusal("agent-not-configured", `No configured agent with ID or harness '${parsed.value.agent}' exists.`);
    }
    if (!taskBounds(checked.bounds) || typeof checked.mechanism !== "string" || !checked.mechanism) return refusal("unbounded-executor", "the executor check did not establish finite deadline/output bounds and a host enforcement mechanism");
    const payload = Buffer.from(JSON.stringify(loc)).toString("base64url");
    const address = `task_${payload}.${seal(payload, authority.owner)}`;
    const now = new Date().toISOString();
    const finalDeadline = configuredAgent?.bounds?.deadlineMs
      ? Math.min(configuredAgent.bounds.deadlineMs, checked.bounds.deadlineMs)
      : checked.bounds.deadlineMs;
    const finalMaxOutput = configuredAgent?.bounds?.maxOutputBytes
      ? Math.min(configuredAgent.bounds.maxOutputBytes, checked.bounds.maxOutputBytes)
      : checked.bounds.maxOutputBytes;
    const record = {
      address, environment, placement: "machine", owner: authority.owner, root: { kind: "machine", path: canonical, environment },
      project: selected.project, instance, callId: authority.callId, input: parsed.value,
      agentId: configuredAgent?.id ?? parsed.value.agent,
      harness: configuredAgent?.harness ?? parsed.value.agent,
      agentConfig: configuredAgent ? Object.freeze({ ...configuredAgent }) : null,
      bounds: { deadlineMs: finalDeadline, maxOutputBytes: finalMaxOutput }, mechanism: checked.mechanism, boot, pid,
      state: "queued", createdAt: now, updatedAt: now,
    };
    append(loc, { address, state: "queued", created: record }, record.project, record.callId);
    activeRuns.set(address, { controller: new AbortController() });
    // Environment-owned, never connection-owned. Admission returns without awaiting the executor.
    setImmediate(() => { void run(loc, record, implementation); });
    return { ok: true, task: taskView(record), existing: false };
  }

  return {
    call(tool, args, authority) {
      if (typeof authority?.owner !== "string" || !authority.owner) return refusal("task-owner-unverified", "tasks require an authenticated paired caller, not ambient local access");
      if (!/^env_[0-9a-f]{16}$/.test(environment) || !addressKey || Buffer.byteLength(addressKey) < 32) return refusal("task-environment-unverified", "task admission requires the host's self key and protected address-sealing key");
      try {
        if (tool === "delegate_task") return admit(args, authority);
        if (tool === "cancel_task") {
          if (!args || typeof args.address !== "string" || Object.keys(args).some((k) => k !== "address")) return refusal("invalid-task-address", "cancel_task takes only an address; the transport owns identity");
          const loc = locate(args.address, authority.owner);
          // cancelTask is async: refusals resolve as values, never as rejections the caller must guess at
          return cancelTask(loc, args.address, authority.owner).catch((err) => refusal(err.refused ?? "cancel-failed", err.message));
        }
        if (tool !== "task_status") return refusal("unknown-tool", "not a task tool");
        if (!args || Object.keys(args).some((k) => k !== "address")) return refusal("invalid-task-address", "task_status takes only an address; the transport owns identity");
        const loc = locate(args.address, authority.owner);
        const view = taskView(recordAt(loc, args.address, authority.owner));
        // D6 progress is surfaced at the safe boundary (status reads), coalesced to the latest note.
        if (!taskTerminal(view.state)) { const p = latestProgress.get(args.address); if (p) view.progress = p; }
        return { ok: true, task: view };
      } catch (err) {
        return refusal(err.refused ?? "task-admission-failed", err.refused ? err.message : "task admission/readback failed; no new execution was authorised");
      }
    },
    progressFor, // D6: the coalesced progress note, for surfaces that poll between turn boundaries
  };
}
