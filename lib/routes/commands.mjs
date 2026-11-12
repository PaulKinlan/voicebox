/**
 * @summary Direct command routes: undo, delegate, exec and task status (GET/POST /api/undo, POST /api/delegate, POST /api/exec, GET /api/task), each a thin door onto the host's one execute path.
 */
// Command routes (voicebox-beads-cwx5.1). These are the non-speech doors onto verbs the room also reaches by
// voice. None of them owns behaviour: each hands a verb to the host's `execute`, which is where the root, the
// permission checks and the audit live. What a route DOES own is its boundary, declared here as data:
//
//   POST /api/undo      csrf   it reads no body, so the JSON door cannot cover it; a browser request from
//                              outside the local page is refused (voicebox-beads-3bwx)
//   POST /api/delegate  json   the strict JSON door
//   POST /api/exec      json   the strict JSON door
import { defineRoutes } from "./guarded.mjs";

/** The command refusals the executor already records as work activity itself; every other one is recorded here. */
const EXECUTOR_RECORDED = new Set(["command-refused", "command-failed", "command-timed-out"]);

/**
 * `execute(action)` is the host's verb executor. `getActive()` is the declared root (`{ root }` or null),
 * `undoStackFor(rootPath)` the live undo stack for a root, `taskStatus(address)` the task registry's status
 * call under the local owner, and `recordWorkActivity` the room's activity log.
 */
export function createCommandRoutes({ execute, getActive, noRootDeclared, undoStackFor, taskStatus, recordWorkActivity, json }) {
  const answer = (res, result, refusedStatus = 400) => json(res, result.ok ? 200 : refusedStatus, result);

  return defineRoutes("commands", [
    {
      key: "GET /api/undo",
      guard: "read",
      handler: (_req, res) => {
        const active = getActive();
        if (!active) return json(res, 409, { ...noRootDeclared() });
        const stack = undoStackFor(active.root.path) ?? [];
        const last = stack.length > 0 ? stack[stack.length - 1] : null;
        return json(res, 200, {
          ok: true,
          canUndo: stack.length > 0,
          count: stack.length,
          last: last ? { verb: last.verb, name: last.name, at: last.at } : null,
          root: active.root,
        });
      },
    },
    {
      key: "POST /api/undo",
      guard: "csrf",
      handler: async (_req, res) => answer(res, await execute({ verb: "undo" })),
    },
    {
      key: "POST /api/delegate",
      guard: "json",
      handler: async (_req, res, _url, { body }) =>
        answer(res, await execute({ verb: "delegate_task", agent: body?.agent, task: body?.task })),
    },
    {
      key: "POST /api/exec",
      guard: "json",
      handler: async (_req, res, _url, { body }) => {
        const command = typeof body?.command === "string" ? body.command : "";
        const cwd = typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined;
        const result = await execute({ verb: "exec", command, ...(cwd ? { cwd } : {}) });
        if (!result.ok && !EXECUTOR_RECORDED.has(result.refused)) {
          recordWorkActivity({
            kind: "command",
            summary: command ? `exec: ${command}` : "exec",
            detail: result.why ?? result.refused ?? "Refused",
            status: "error",
          });
        }
        return answer(res, result);
      },
    },
    {
      key: "GET /api/task",
      guard: "read",
      handler: (_req, res, url) => answer(res, taskStatus(url.searchParams.get("address") ?? ""), 404),
    },
  ]);
}
