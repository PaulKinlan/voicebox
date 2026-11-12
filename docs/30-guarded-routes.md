# Guarded Routes: how HTTP routes declare their boundary

Status: in use for the Mini-App, agent and permission routes; the remaining inline routes in `server.mjs` are being moved onto it (voicebox-beads-cwx5.1).

Every HTTP route that changes state needs a security boundary. Until this design, that boundary was a line inside each handler, and `tests/csrf-route-seam.test.mjs` proved it was still there by scanning the source text of `server.mjs`. Adding or moving a route meant editing `server.mjs` and that test by hand, which made both files merge-conflict hotspots.

A guarded route states its boundary as data, and one dispatcher enforces it.

## Adding a route

Routes live in one module per area under `lib/routes/`. A module exports a factory that returns `defineRoutes(area, [...])`:

```js
import { defineRoutes } from "./guarded.mjs";

export function createThingRoutes({ json, things }) {
  return defineRoutes("things", [
    { key: "GET /api/things", guard: "read", handler: (_req, res) => json(res, 200, things.list()) },
    {
      key: "POST /api/things",
      guard: "json",
      handler: (_req, res, _url, { body }) => json(res, 200, things.add(body)),
    },
  ]);
}
```

The host builds the area once and adds it to the dispatcher's list in `server.mjs`:

```js
const thingRoutes = createThingRoutes({ json, things });
const guardedRoutes = createGuardedDispatcher({ routes: [...miniAppRoutes, ...agentRoutes, ...thingRoutes], checks, json, readJsonBody });
```

That one list entry is the only edit to `server.mjs`. Two areas never touch the same lines of a handler.

## The guards

| Guard | Who passes | What the dispatcher does |
|---|---|---|
| `read` | Anyone behind the host's auth wall | Nothing. Only allowed on `GET`, `HEAD` and `OPTIONS`. |
| `json` | A request declaring `application/json` within the size cap | Reads the body through the bounded JSON door before the handler runs and passes it as `ctx.body` (`null` if malformed). `maxBytes` on the route raises the cap for content routes. |
| `csrf` | Machine callers without browser headers, this local page, a valid host token | Refuses a browser request from any other origin with `403 cross-origin-request-refused`. For routes that cannot require a JSON content type. |
| `host-token` | A valid `x-voicebox-host-token` | Refuses everything else with `403 host-authority-required`. |
| `authority` | The host token, the room session token, or this page's own `Origin` | Refuses everything else with `403 authority-required`. |
| `room-authority` | The host token or the room session token | As `authority`, but a bare `Origin` header is not enough. |
| `wall` | Anyone behind the host's auth wall | Nothing, on a mutating route. The route must give its reason in `because`. |

## Route options

| Option | Applies to | Meaning |
|---|---|---|
| `maxBytes` | Any route that reads a JSON body | The size cap the JSON door enforces. Defaults to 1 MiB. |
| `body: "json"` | `csrf`, `host-token`, `authority`, `room-authority` | After the guard passes, read the body through the JSON door into `ctx.body`. An unauthorised caller is refused before any of its body is read. |
| `refusal: { refused, why }` | The same four guards | What the route answers with a `403` when its guard fails, in place of the standard sentence. Use it when a route's refusal name is already part of the wire contract. |
| `because` | `wall` | Required. Why this mutating route has no boundary of its own. |

A key may contain parameters: `PATCH /api/agents/:id` matches exactly one path segment made of letters, digits, `_` and `-`, and the handler receives it as `ctx.params.id`. Dots, slashes and percent-escapes never match, so a parameter cannot smuggle a path. A literal key always wins over a parameterised one, and two parameterised keys that would match the same requests are refused at definition time.

```js
{
  key: "PATCH /api/agents/:id",
  guard: "authority",
  body: "json",
  handler: (_req, res, _url, { body, params }) => json(res, 200, agents.update(params.id, body)),
}
```

## How it works

```mermaid
flowchart TD
  Req["HTTP request"] --> Wall{"Loopback auth wall<br/>(opt-in, server.mjs)"}
  Wall -- "no session" --> R401["401 loopback-unauthenticated"]
  Wall -- "ok" --> Lookup{"Key in the guarded table?<br/>METHOD + path"}
  Lookup -- "no" --> Legacy["Remaining inline routes<br/>in server.mjs"]
  Lookup -- "yes (literal key first,<br/>then :param keys)" --> Guard{"Route's declared guard"}
  Guard -- "check fails" --> R403["403 named refusal<br/>handler never runs"]
  Guard -- "json, or passes<br/>with body: json" --> Door["Bounded JSON door<br/>415 / 413 answered here"]
  Guard -- "check passes,<br/>no body declared" --> Handler["Area handler<br/>lib/routes/&lt;area&gt;.mjs"]
  Door -- "body read" --> Handler
  Handler --> Res["Response"]
```

Three properties follow from the structure rather than from review:

1. **A route cannot exist without a guard.** `defineRoutes()` throws when the module is imported if a route has no guard, an unknown guard, a duplicate key, a mutating verb declared `read`, or a `wall` with no reason. The server does not start.
2. **A handler cannot forget its guard.** The dispatcher runs the check first and only then calls the handler. A `json` handler never reads the request stream itself.
3. **Moving a route changes no test.** `tests/guarded-routes.test.mjs` drives `defineRoutes()` and the dispatcher directly and asserts each area's declared guards as a table. `tests/csrf-route-seam.test.mjs` skips modules that declare guards and instead checks that each one is wired into the host's dispatcher.

## What is not covered yet

- A parameter matches one conservative segment. Routes that need a percent-decoded or free-form segment (`/api/environments/<key>`) still live inline in `server.mjs` until that area is moved.
- Most inline routes in `handle()` are still to be moved, one area per pull request.
- The loopback auth wall and the WebSocket upgrades (`/live`, `/channel`) are separate boundaries and are unchanged. See [`18-loopback-session-auth.md`](18-loopback-session-auth.md).
