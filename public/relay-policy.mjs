// public/relay-policy.mjs — WHAT the mini-app fetch relay will carry, decided once (voicebox-beads-j6im).
//
// THE DEFECT THIS ANSWERS. public/relay-target.mjs (voicebox-beads-zus7) decided only that a target was
// SAME-ORIGIN, and the relay then fetched it with the bridge page's own authority. Same-origin is not the
// same claim as "this frame may make this request": server.mjs's `hasExtensionAuthority` treats any request
// carrying this page's Origin as the room operator, and lib/routes/branches.mjs gates only on that — so a
// sandboxed app with an opaque origin could ask the bridge to `POST /api/branches/merge` and land a branch
// into the repository (`git checkout` + `git merge`), or `DELETE /api/file`, with the room's authority.
// The reviewer's repro drove exactly that and got `{ok:true, status:200}`.
//
// SO THE RELAY IS NOW A POLICY, NOT A PROXY. Every relayed request is classified into one of three
// outcomes, and the tables below are the ONLY place that answer lives:
//
//   read        a GET/HEAD of an API this surface is explicitly approved to READ. Relayed as before —
//               this is the capability the sandbox existed to grant the app (the landing inspector reading
//               the real candidate list instead of showing its fabricated fixtures).
//   host-action a request that MUTATES host state. It is never fetched by the bridge on the app's behalf:
//               the app reaches the room through `host_action_request`, the room re-checks this same
//               policy, and the room performs the fetch itself only after a person answers an explicit
//               consent prompt naming the app, the route and the body. That is the separate, deliberate
//               authorization path the finding asked for — the app never holds the room's Origin.
//   refuse      everything else, by name.
//
// WHY THE TABLES ARE INSIDE THE FUNCTION. The frame-side SDK is injected as source text and embeds this
// exact function with `String(relayPolicy)` (see public/mini-app-bridge.js), the same way relayTarget and
// relayBody are shared — one implementation, two realms, no drift. That only works while the body reads
// nothing outside its own arguments. The frame's copy is advisory (it refuses early with a clear error);
// the BRIDGE's copy is the boundary, and the ROOM's copy is the authority.
//
// @param {unknown} method   the request method, as the caller wrote it
// @param {unknown} pathname the RESOLVED path on this origin ("/api/branches/merge"); query and hash are
//                           not part of the decision, and an absolute URL is a programming error, not a path
// @returns {{ok: true, kind: "read"}} | {{ok: true, kind: "host-action", action: string, route: string}}
//        | {{ok: false, refused: string, why: string}}
export function relayPolicy(method, pathname) {
  // Reads this surface is approved to perform. Deliberately NOT here: /api/keys, /api/agent-settings,
  // /api/root, /api/file(s) and /api/grep — configuration secrets and workspace file bytes are not a
  // sandboxed app's read capability, and the relay used to hand them over without asking.
  var READS = {
    "/api/health": true,
    "/api/activity": true,
    "/api/agents": true,
    "/api/branches/candidates": true,
    "/api/branches/diff": true,
    "/api/changelog": true,
    "/api/doctor": true,
    "/api/extensions": true,
    "/api/extensions/catalogue": true,
    "/api/fleet": true,
    "/api/gemini/capabilities": true,
    "/api/harnesses": true,
    "/api/mini-apps": true,
    "/api/presence": true,
    "/api/tasks": true,
    "/api/tools": true,
  };
  // Mutations the room will perform for an app AFTER a person approves them, and no others: each one is a
  // route an app in public/apps/ actually needs, and the value is the plain-language action the consent
  // prompt names. Adding a route here is therefore a deliberate decision someone reviews, not a side effect
  // of an app being written.
  var HOST_ACTIONS = {
    "POST /api/branches/merge": "land a candidate branch into the base branch",
    "POST /api/branches/keep-separate": "record a candidate branch as kept separate",
    "POST /api/harnesses/configure": "configure an agent harness",
    "POST /api/tasks/delegate": "delegate a background task to an agent",
  };

  var verb = typeof method === "string" ? method.toUpperCase() : "";
  if (!verb) {
    return { ok: false, refused: "relay-no-method", why: "the relay was given no request method" };
  }
  if (typeof pathname !== "string" || pathname.charAt(0) !== "/" || /[\u0000-\u001f\u007f]/.test(pathname)) {
    return {
      ok: false,
      refused: "relay-bad-path",
      why: "the relay serves a resolved path on this page's origin (starting with '/'), never an absolute URL",
    };
  }

  if (verb === "GET" || verb === "HEAD") {
    if (READS[pathname] === true) return { ok: true, kind: "read" };
    return {
      ok: false,
      refused: "relay-read-not-approved",
      why: `${verb} ${pathname} is not one of the read-only APIs a mini-app may fetch through the relay; ` +
        "the room hands an app no workspace files, keys or settings, and this refusal is by name",
    };
  }

  var route = verb + " " + pathname;
  if (HOST_ACTIONS[route]) {
    return { ok: true, kind: "host-action", action: HOST_ACTIONS[route], route };
  }
  return {
    ok: false,
    refused: "relay-mutation-not-approved",
    why: `${route} changes host state and is not an action this surface may request; the relay carries ` +
      "reads only, and a host action needs the room's operator to approve it from the list of approved actions",
  };
}
