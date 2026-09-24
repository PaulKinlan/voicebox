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
// Coordination semantics (states, cancellation, terminal outcomes) stay IDENTICAL across placements.

import {
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
  if (!taskBounds(bounds)) {
    return refusal("unbounded-executor", "task bounds must specify positive integer deadlineMs and maxOutputBytes");
  }
  const limits = PLACEMENT_BOUNDS[placement] ?? PLACEMENT_BOUNDS.machine;
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

  const activeRuns = new Map();
  const latestProgress = new Map();
  const tasks = new Map();

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
    return loc;
  }

  async function cancelTask(address, owner, graceMs = 1500) {
    await locate(address, owner);
    const record = tasks.get(address);
    if (!record) fail("task-not-found", "the task record does not exist in browser storage");
    if (taskTerminal(record.state)) {
      fail("task-not-running", `the task is already ${record.state}; cancel applies to a running task`);
    }
    if (!activeRuns.has(address)) {
      record.state = "cancel_unconfirmed";
      record.reason = "no active runner in this browser context holds the task; whether work stopped is unknown";
      record.updatedAt = new Date().toISOString();
      return { ok: true, state: record.state, observed: false };
    }
    record.state = "cancel_requested";
    record.reason = "the user asked to stop";
    record.updatedAt = new Date().toISOString();

    const running = activeRuns.get(address);
    running.controller.abort(Object.assign(new Error("the user asked to stop this task"), { refused: "task-cancelled" }));

    const t0 = Date.now();
    while (Date.now() - t0 < graceMs) {
      if (taskTerminal(record.state)) return { ok: true, state: record.state, observed: true };
      await new Promise((r) => setTimeout(r, 25));
    }
    record.state = "cancel_unconfirmed";
    record.reason = `the browser executor did not observe cancellation within ${graceMs}ms; whether the work stopped is unknown`;
    record.updatedAt = new Date().toISOString();
    return { ok: true, state: record.state, observed: false };
  }

  async function runTask(address, record, implementation) {
    const running = activeRuns.get(address);
    if (!running) return;
    let timer;
    try {
      record.state = "running";
      record.updatedAt = new Date().toISOString();

      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          running.controller.abort();
          reject(Object.assign(new Error("browser task deadline elapsed"), { refused: "task-deadline" }));
        }, record.bounds.deadlineMs);
      });

      const report = (note) => {
        if (typeof note !== "string" || !note.trim()) return;
        latestProgress.set(address, note.slice(0, 300));
      };

      const input = Object.freeze({ ...record.input, context: Object.freeze([...record.input.context]) });
      const bounds = Object.freeze({ ...record.bounds });
      const currentRoot = Object.freeze({ ...record.root });

      const execution = Promise.resolve().then(() =>
        implementation.run({ input, bounds, signal: running.controller.signal, report, root: currentRoot }),
      );

      const answer = await Promise.race([execution, deadline]);
      clearTimeout(timer);

      if (typeof answer !== "string") fail("task-invalid-result", "the executor did not return text");
      if (new TextEncoder().encode(answer).length > record.bounds.maxOutputBytes) {
        fail("task-output-over-budget", "the executor result exceeded the admitted output bound");
      }

      record.state = "completed";
      record.answer = answer;
      record.progress = latestProgress.get(address) ?? null;
      record.updatedAt = new Date().toISOString();
    } catch (err) {
      clearTimeout(timer);
      const state = err?.refused === "task-cancelled" ? "cancelled"
        : err?.refused === "task-deadline" ? "interrupted"
        : "failed";
      record.state = state;
      record.reason = err.refused ?? "executor-failed";
      record.progress = latestProgress.get(address) ?? null;
      record.updatedAt = new Date().toISOString();
    } finally {
      latestProgress.delete(address);
      activeRuns.delete(address);
    }
  }

  async function admit(args, authority) {
    const parsed = taskInput(args);
    if (!parsed.ok) return parsed;
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(authority.callId ?? "")) {
      return refusal("task-call-id-required", "the authenticated transport must provide a stable call id, outside model arguments");
    }

    const selected = root();
    if (!selected) {
      return refusal("task-root-unavailable", "task delegation requires a declared root descriptor; none declared");
    }

    if (activeRuns.size >= PLACEMENT_BOUNDS.browser.maxActiveTasks) {
      return refusal("task-capacity-exhausted", `browser environment capacity exhausted (${PLACEMENT_BOUNDS.browser.maxActiveTasks} max active tasks)`);
    }

    const implementation = executor();
    if (!implementation) {
      return refusal("executor-unavailable", `no admitted task executor for '${parsed.value.agent}' in browser placement`);
    }

    if (typeof implementation.check !== "function" || typeof implementation.run !== "function") {
      return refusal("unbounded-executor", `no host-enforced executor for '${parsed.value.agent}'`);
    }

    const checked = implementation.check({
      input: parsed.value,
      root: Object.freeze({ ...selected }),
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

    const locId = `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const loc = {
      environment,
      instance,
      placement: "browser",
      path: selected.path ?? selected.id ?? "root",
      id: locId,
    };
    const payload = base64UrlEncode(JSON.stringify(loc));
    const signature = await seal(payload, authority.owner);
    const address = `task_${payload}.${signature}`;
    const now = new Date().toISOString();

    const record = {
      address,
      environment,
      placement: "browser",
      owner: authority.owner,
      root: selected,
      project: options.project ?? "browser-project",
      instance,
      callId: authority.callId,
      input: parsed.value,
      bounds: { deadlineMs: checked.bounds.deadlineMs, maxOutputBytes: checked.bounds.maxOutputBytes },
      mechanism: checked.mechanism,
      boot,
      state: "queued",
      createdAt: now,
      updatedAt: now,
    };

    tasks.set(address, record);
    activeRuns.set(address, { controller: new AbortController() });

    // Asynchronous dispatch with zero Node dependencies
    queueMicrotask(() => { void runTask(address, record, implementation); });

    return { ok: true, task: taskView(record), existing: false };
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
          const record = tasks.get(args.address);
          if (!record) return refusal("task-not-found", "the task record was not found");
          const view = taskView(record);
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
      const host = hosts[placement];
      if (!host) {
        return refusal("placement-unavailable", `no task host available for placement '${placement}' in environment '${typeof envTarget === "string" ? envTarget : envTarget?.key ?? "unknown"}'`);
      }
      return { ok: true, placement, host };
    },
  };
}
