// lib/task-placement.mjs — Zero-server browser-owned delegation contract (voicebox-beads-8fv.1)
//
// Hard requirement (Paul, 2026-09-21):
//   "there is a world where there is zero server and it's all run locally on the client,
//    and that has to be a hard requirement."
//
// Placement is an environment property:
//   - "browser": execution runs in-page or in a web worker; zero Voicebox server or local bridge needed.
//   - "machine": execution runs in a local machine process / stdio CLI.
//   - "remote": execution runs in a remote paired session over network.
//
// Invariants enforced (voicebox-beads-8fv.1):
//   1. Unambiguous tuple identity: distinct (owner, callId) pairs use null separator (\0); foreign owners cannot read or share records.
//   2. Simultaneous call-ID deduplication: pending calls await the same admission promise; retries execute once.
//   3. Immutability: root descriptor and bounds captured synchronously before async signing window.
//   4. Durable persistence gate: storage failures fail closed; call index is derivable from persisted task records.
//   5. Reload call-ID recovery: durable callId mapping survives page reload; repeated callId reuses existing task.
//   6. Lost runner reconciliation: tasks from differing boot generations report stale=true without fabricating host-observed death.
//   7. Alive capacity retention: timed-out runners retain capacity allocation until runner promise actually settles.
//   8. Outcome contract: terminal states carry outcome class and basis (claimed-complete / executor-claimed).

import {
  outcomeFor,
  placementForEnvironment,
  PLACEMENT_BOUNDS,
  taskBounds,
  taskInput,
  taskTerminal,
  taskView,
} from "../core/tasks.ts";

export { placementForEnvironment, PLACEMENT_BOUNDS };

const refusal = (refused, why) => ({ ok: false, refused, why });
const fail = (refused, why) => { throw Object.assign(new Error(why), { refused }); };

/**
 * Validate that execution bounds adhere to the limits of the target placement.
 */
export function validatePlacementBounds(placement, bounds) {
  if (!placement || !PLACEMENT_BOUNDS[placement]) {
    return refusal("unbounded-executor", `unknown placement '${placement}'`);
  }
  if (!taskBounds(bounds)) {
    return refusal("unbounded-executor", "task bounds must specify positive integer deadlineMs and maxOutputBytes");
  }
  const limits = PLACEMENT_BOUNDS[placement];
  if (bounds.deadlineMs > limits.maxDeadlineMs) {
    return refusal("unbounded-executor", `deadline ${bounds.deadlineMs}ms exceeds the ${placement} placement maximum of ${limits.maxDeadlineMs}ms`);
  }
  if (bounds.maxOutputBytes > limits.maxOutputBytes) {
    return refusal("unbounded-executor", `output limit ${bounds.maxOutputBytes} bytes exceeds the ${placement} placement maximum of ${limits.maxOutputBytes} bytes`);
  }
  return { ok: true, bounds };
}

/**
 * Simple portable SHA-256 HMAC for browser/zero-server environments using WebCrypto.
 */
async function portableHmac(keyBytes, dataString) {
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, enc.encode(dataString));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(str) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str).toString("base64url");
  }
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "base64url").toString("utf8");
  }
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(base64)));
}

// Global in-memory maps for environments lacking localStorage (Node/workers)
const globalMemoryTasks = new Map();
const globalMemoryCalls = new Map();

/**
 * createBrowserTaskHost — zero-server, environment-owned task host.
 *
 * Runs entirely in the client (tab, worker) with zero backend, local proxy, or Node imports.
 * Accepts OPFS, handle, or portable roots, enforces browser placement bounds, and provides
 * durable state tracking and cancellation honesty without process spawning.
 */
export function createBrowserTaskHost(options = {}) {
  const environment = options.environment ?? "env_browser_local";
  const instance = options.instance ?? "browser-tab";
  const boot = options.boot ?? `boot_${Date.now().toString(36)}`;
  const root = options.root ?? (() => ({ kind: "opfs", path: "v1/tasks", environment }));
  const executor = options.executor ?? (() => null);

  // Signing key for sealing task locators (WebCrypto-compatible 32-byte secret)
  const keyBytes = options.keyBytes ?? new Uint8Array(32).fill(42);
  const keyEpoch = Array.from(keyBytes).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

  const activeRuns = new Map();
  const latestProgress = new Map();
  const tasks = new Map();
  const callRecords = new Map();
  const pendingCalls = new Map(); // Scoped key -> Promise for concurrent in-flight admission

  let activeCount = 0; // Synchronous atomic reservation counter for concurrent admission

  function scopedCallKey(owner, callId) {
    return `${environment}\0${keyEpoch}\0${owner}\0${callId}`;
  }

  function persistTaskStrict(rec) {
    tasks.set(rec.address, rec);
    globalMemoryTasks.set(rec.address, rec);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`vb_task_${rec.address}`, JSON.stringify(rec));
      } catch (err) {
        throw Object.assign(new Error("the task event was not durably confirmed; execution is not authorised"), {
          refused: "task-persistence-failed",
        });
      }
    }
  }

  function persistTaskQuiet(rec) {
    tasks.set(rec.address, rec);
    globalMemoryTasks.set(rec.address, rec);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`vb_task_${rec.address}`, JSON.stringify(rec));
      }
    } catch {}
  }

  function persistCallRecord(owner, callId, address) {
    const key = scopedCallKey(owner, callId);
    callRecords.set(key, address);
    globalMemoryCalls.set(key, address);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`vb_call_${key}`, address);
      } catch (err) {
        // Strict: fail closed if index persistence fails
        throw Object.assign(new Error("the task call index was not durably confirmed; execution is not authorised"), {
          refused: "task-persistence-failed",
        });
      }
    }
  }

  function persistCallRecordQuiet(owner, callId, address) {
    const key = scopedCallKey(owner, callId);
    callRecords.set(key, address);
    globalMemoryCalls.set(key, address);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(`vb_call_${key}`, address);
      }
    } catch {}
  }

  function retrieveTask(addr) {
    let r = tasks.get(addr);
    if (!r) {
      r = globalMemoryTasks.get(addr);
      if (r) tasks.set(addr, r);
    }
    if (!r && typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(`vb_task_${addr}`);
        if (raw) {
          r = JSON.parse(raw);
          tasks.set(addr, r);
          globalMemoryTasks.set(addr, r);
        }
      } catch {}
    }
    return r ?? null;
  }

  function isValidTask(task, owner) {
    if (!task || task.owner !== owner || task.environment !== environment) return false;
    const match = /^task_([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(task.address);
    if (!match) return false;
    try {
      const loc = JSON.parse(base64UrlDecode(match[1]));
      if (loc.environment !== environment || loc.keyEpoch !== keyEpoch) return false;
    } catch {
      return false;
    }
    return true;
  }

  function retrieveCall(owner, callId) {
    const key = scopedCallKey(owner, callId);
    let addr = callRecords.get(key) ?? globalMemoryCalls.get(key);
    if (!addr && typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(`vb_call_${key}`);
        if (stored) {
          addr = stored;
          callRecords.set(key, addr);
          globalMemoryCalls.set(key, addr);
        }
      } catch {}
    }
    if (addr) {
      const task = retrieveTask(addr);
      if (isValidTask(task, owner)) {
        return task;
      }
    }
    // Derivable index fallback: search stored tasks for matching owner, callId, environment, and keyEpoch
    for (const task of tasks.values()) {
      if (task.callId === callId && isValidTask(task, owner)) {
        persistCallRecordQuiet(owner, callId, task.address);
        return task;
      }
    }
    if (typeof localStorage !== "undefined") {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith("vb_task_")) {
            const raw = localStorage.getItem(k);
            if (raw) {
              const task = JSON.parse(raw);
              if (task.callId === callId && isValidTask(task, owner)) {
                tasks.set(task.address, task);
                globalMemoryTasks.set(task.address, task);
                persistCallRecordQuiet(owner, callId, task.address);
                return task;
              }
            }
          }
        }
      } catch {}
    }
    return null;
  }

  async function seal(payload, owner) {
    return portableHmac(keyBytes, `${payload}\0${owner}`);
  }

  async function locate(address, owner) {
    if (typeof address !== "string" || address.length > 8192) fail("invalid-task-address", "a task address is a bounded string");
    const match = /^task_([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(address);
    if (!match) fail("invalid-task-address", "the task address is malformed");
    const expectedSig = await seal(match[1], owner);
    if (match[2] !== expectedSig) {
      fail("task-owner-mismatch", "the address is not valid for this authenticated owner and browser key epoch");
    }
    let loc;
    try { loc = JSON.parse(base64UrlDecode(match[1])); }
    catch { fail("invalid-task-address", "the task locator is not readable"); }
    if (loc.environment !== environment) fail("task-environment-changed", "this task belongs to a different environment identity");
    if (loc.keyEpoch !== keyEpoch) fail("task-owner-mismatch", "the task address was sealed under a different key epoch");
    return loc;
  }

  async function cancelTask(address, owner, graceMs = 1500) {
    await locate(address, owner);
    let record = retrieveTask(address);
    if (!record) fail("task-not-found", "the task record does not exist in browser storage");
    if (taskTerminal(record.state)) {
      fail("task-not-running", `the task is already ${record.state}; cancel applies to a running task`);
    }
    if (!activeRuns.has(address)) {
      record.state = "cancel_unconfirmed";
      record.reason = "no active runner in this browser context holds the task; whether work stopped is unknown";
      record.updatedAt = new Date().toISOString();
      persistTaskQuiet(record);
      return { ok: true, state: record.state, observed: false };
    }
    record.state = "cancel_requested";
    record.reason = "the user asked to stop";
    record.updatedAt = new Date().toISOString();
    persistTaskQuiet(record);

    const running = activeRuns.get(address);
    running.controller.abort(Object.assign(new Error("the user asked to stop this task"), { refused: "task-cancelled" }));

    const t0 = Date.now();
    while (Date.now() - t0 < graceMs) {
      if (taskTerminal(record.state)) return { ok: true, state: record.state, observed: true };
      await new Promise((r) => setTimeout(r, 20));
    }
    record.state = "cancel_unconfirmed";
    record.reason = `the browser executor did not observe cancellation within ${graceMs}ms; whether the work stopped is unknown`;
    record.updatedAt = new Date().toISOString();
    persistTaskQuiet(record);
    return { ok: true, state: record.state, observed: false };
  }

  async function runTask(address, record, implementation, executionPromise, capturedBounds) {
    const running = activeRuns.get(address);
    if (!running) return;
    let timer;
    try {
      record.state = "running";
      record.updatedAt = new Date().toISOString();
      persistTaskQuiet(record);

      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          running.controller.abort();
          reject(Object.assign(new Error("browser task deadline elapsed"), { refused: "task-deadline" }));
        }, capturedBounds.deadlineMs);
      });

      const answer = await Promise.race([executionPromise, deadline]);
      clearTimeout(timer);

      if (typeof answer !== "string") fail("task-invalid-result", "the executor did not return text");
      if (new TextEncoder().encode(answer).length > capturedBounds.maxOutputBytes) {
        fail("task-output-over-budget", "the executor result exceeded the admitted output bound");
      }

      record.state = "completed";
      record.answer = answer;
      record.outcome = outcomeFor("completed");
      record.progress = latestProgress.get(address) ?? null;
      record.updatedAt = new Date().toISOString();
      persistTaskQuiet(record);
    } catch (err) {
      clearTimeout(timer);
      const state = err?.refused === "task-cancelled" ? "cancelled"
        : err?.refused === "task-deadline" ? "interrupted"
        : "failed";
      record.state = state;
      record.reason = err.refused ?? "executor-failed";
      record.outcome = outcomeFor(state) ?? undefined;
      record.progress = latestProgress.get(address) ?? null;
      record.updatedAt = new Date().toISOString();
      persistTaskQuiet(record);
    } finally {
      latestProgress.delete(address);
      // Retain capacity reservation until execution promise actually settles
      const release = () => {
        activeRuns.delete(address);
        activeCount = Math.max(0, activeCount - 1);
      };
      if (executionPromise) {
        void Promise.resolve(executionPromise).then(release, release);
      } else {
        release();
      }
    }
  }

  async function admit(args, authority) {
    const parsed = taskInput(args);
    if (!parsed.ok) return parsed;
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(authority.callId ?? "")) {
      return refusal("task-call-id-required", "the authenticated transport must provide a stable call id, outside model arguments");
    }

    const callKey = scopedCallKey(authority.owner, authority.callId);

    // Await any concurrent in-flight admission for the exact same owner/callId tuple
    const inflight = pendingCalls.get(callKey);
    if (inflight) {
      const existing = await inflight;
      if (!existing.ok) return existing;
      if (JSON.stringify(existing.record.input) !== JSON.stringify(parsed.value)) {
        return refusal("task-call-id-conflict", "that call id already admitted different task content");
      }
      return { ok: true, task: existing.task, existing: true };
    }

    // Call-ID deduplication: repeated stable callId must return existing record or conflict
    const existing = retrieveCall(authority.owner, authority.callId);
    if (existing) {
      if (existing.owner !== authority.owner) {
        return refusal("task-owner-mismatch", "call id belongs to another owner");
      }
      if (JSON.stringify(existing.input) !== JSON.stringify(parsed.value)) {
        return refusal("task-call-id-conflict", "that call id already admitted different task content");
      }
      return { ok: true, task: taskView(existing), existing: true };
    }

    const selected = root();
    if (!selected) {
      return refusal("task-root-unavailable", "task delegation requires a declared root descriptor; none declared");
    }

    // Atomic synchronous capacity reservation BEFORE any async boundary
    if (activeCount >= PLACEMENT_BOUNDS.browser.maxActiveTasks) {
      return refusal("task-capacity-exhausted", `browser environment capacity exhausted (${PLACEMENT_BOUNDS.browser.maxActiveTasks} max active tasks)`);
    }

    const implementation = executor();
    if (!implementation) {
      return refusal("executor-unavailable", `no admitted task executor for '${parsed.value.agent}' in browser placement`);
    }

    if (typeof implementation.check !== "function" || typeof implementation.run !== "function") {
      return refusal("unbounded-executor", `no host-enforced executor for '${parsed.value.agent}'`);
    }

    // Capture root and bounds immediately (immutability against caller mutations)
    const capturedRoot = Object.freeze(JSON.parse(JSON.stringify(selected)));

    const checked = implementation.check({
      input: parsed.value,
      root: capturedRoot,
      environment,
      placement: "browser",
    });

    if (checked && typeof checked.then === "function") {
      void Promise.resolve(checked).catch(() => {});
      return refusal("unbounded-executor", "task admission requires a synchronous host boundary check");
    }
    if (!checked || checked.ok !== true) {
      return { ok: false, refused: checked?.refused ?? "unbounded-executor", why: checked?.why ?? "executor check failed" };
    }

    const boundCheck = validatePlacementBounds("browser", checked.bounds);
    if (!boundCheck.ok) return boundCheck;

    if (typeof checked.mechanism !== "string" || !checked.mechanism) {
      return refusal("unbounded-executor", "executor check did not establish a host enforcement mechanism");
    }

    const capturedBounds = Object.freeze({
      deadlineMs: checked.bounds.deadlineMs,
      maxOutputBytes: checked.bounds.maxOutputBytes,
    });

    // Synchronously reserve capacity slot and pending call promise
    activeCount++;

    let resolvePending, rejectPending;
    const admissionPromise = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    pendingCalls.set(callKey, admissionPromise);

    let signature;
    const locId = `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const loc = {
      environment,
      keyEpoch,
      instance,
      placement: "browser",
      path: capturedRoot.path ?? capturedRoot.id ?? "root",
      id: locId,
    };
    const payload = base64UrlEncode(JSON.stringify(loc));

    try {
      signature = await seal(payload, authority.owner);
    } catch (e) {
      activeCount = Math.max(0, activeCount - 1);
      pendingCalls.delete(callKey);
      rejectPending(e);
      throw e;
    }

    const address = `task_${payload}.${signature}`;
    const now = new Date().toISOString();

    const record = {
      address,
      environment,
      placement: "browser",
      owner: authority.owner,
      root: capturedRoot,
      project: options.project ?? "browser-project",
      instance,
      callId: authority.callId,
      input: parsed.value,
      bounds: capturedBounds,
      mechanism: checked.mechanism,
      boot,
      state: "queued",
      createdAt: now,
      updatedAt: now,
    };

    // Durable persistence MUST succeed before authorizing execution
    try {
      persistTaskStrict(record);
      persistCallRecord(authority.owner, authority.callId, address);
    } catch (err) {
      activeCount = Math.max(0, activeCount - 1);
      pendingCalls.delete(callKey);
      // Clean up unpersisted record from memory
      tasks.delete(address);
      globalMemoryTasks.delete(address);
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem(`vb_task_${address}`);
          localStorage.removeItem(`vb_call_${callKey}`);
        }
      } catch {}
      const res = refusal(err.refused ?? "task-persistence-failed", err.message);
      resolvePending(res);
      return res;
    }

    const controller = new AbortController();
    activeRuns.set(address, { controller });

    // Prepare execution promise capturing frozen context
    const executionPromise = Promise.resolve().then(() =>
      implementation.run({
        input: Object.freeze({ ...record.input, context: Object.freeze([...record.input.context]) }),
        bounds: capturedBounds,
        signal: controller.signal,
        report: (note) => {
          if (typeof note !== "string" || !note.trim()) return;
          latestProgress.set(address, note.slice(0, 300));
        },
        root: capturedRoot,
      }),
    );

    // Asynchronous dispatch with zero Node dependencies
    queueMicrotask(() => {
      void runTask(address, record, implementation, executionPromise, capturedBounds);
    });

    const successResult = { ok: true, record, task: taskView(record), existing: false };
    resolvePending(successResult);
    pendingCalls.delete(callKey);

    return { ok: true, task: successResult.task, existing: false };
  }

  return {
    async call(tool, args, authority) {
      if (typeof authority?.owner !== "string" || !authority.owner) {
        return refusal("task-owner-unverified", "tasks require an authenticated caller");
      }
      try {
        if (tool === "delegate_task") return await admit(args, authority);
        if (tool === "task_status") {
          if (!args || typeof args.address !== "string") return refusal("invalid-task-address", "task_status takes an address");
          await locate(args.address, authority.owner);
          const record = retrieveTask(args.address);
          if (!record) return refusal("task-not-found", "the task record was not found");
          const view = taskView(record);
          if (!taskTerminal(record.state) && record.boot !== boot && !activeRuns.has(record.address)) {
            view.stale = true;
            view.staleReason = "generation-unconfirmed";
          }
          const p = latestProgress.get(args.address);
          if (p && !taskTerminal(view.state)) view.progress = p;
          return { ok: true, task: view };
        }
        if (tool === "cancel_task") {
          if (!args || typeof args.address !== "string") return refusal("invalid-task-address", "cancel_task takes an address");
          return await cancelTask(args.address, authority.owner);
        }
        return refusal("unknown-tool", `unknown task tool '${tool}'`);
      } catch (err) {
        return refusal(err.refused ?? "task-admission-failed", err.message);
      }
    },
    placement: "browser",
    environment,
  };
}

/**
 * Placement dispatcher: chooses the appropriate task host (browser, machine, or remote)
 * based on the target environment's declared placement, without requiring a centralized server broker.
 */
export function createPlacementDispatcher(hosts = {}) {
  return {
    dispatch(envTarget) {
      const placement = placementForEnvironment(envTarget);
      if (!placement) {
        return refusal("placement-unavailable", "unknown environment kind or placement");
      }
      const host = hosts[placement];
      if (!host) {
        return refusal("placement-unavailable", `no task host available for placement '${placement}' in environment '${typeof envTarget === "string" ? envTarget : envTarget?.key ?? "unknown"}'`);
      }
      const targetKey = typeof envTarget === "object" && envTarget !== null ? envTarget.key : envTarget;
      if (host.environment && targetKey && host.environment !== targetKey) {
        return refusal("environment-mismatch", `host environment '${host.environment}' does not match requested '${targetKey}'`);
      }
      return { ok: true, placement, host };
    },
  };
}
