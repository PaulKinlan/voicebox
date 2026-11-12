/**
 * @summary Pairing between environments: issue, record and revoke the bearer one host uses to call another (POST /api/pair, POST /api/pair/complete, DELETE /api/pair), all the host's act.
 */
// Pairing routes (voicebox-beads-cwx5.1). PAIRING CREATES A CREDENTIAL — the same authority class as admitting an
// extension or declaring a root — so every route here declares the `host-token` guard. The page cannot hold that
// token, which is the point: a page must not be able to mint, register or revoke the bearer that lets one
// environment call another. The token is checked by the dispatcher, never logged, and never echoed in a refusal.
//
//   POST /api/pair            the REMOTE side: accept a pairing request and issue a bearer bound to this
//                             environment's key
//   POST /api/pair/complete   the LOCAL side: the person confirmed, the remote issued a bearer, and this host
//                             records the bearer it will use when calling that environment
//   DELETE /api/pair          revoke a pairing (voicebox-beads-yo1); the key rides the body or ?envKey=
import { defineRoutes } from "./guarded.mjs";

const refusalFor = (act) => ({
  refused: "host-token-required",
  why: `${act} requires the host token (x-voicebox-host-token); the page cannot hold it`,
});
const CREATES_A_CREDENTIAL = refusalFor("pairing creates a credential — it is the host's act and");

/**
 * `mintBearer()` returns a fresh bearer string. `storeBearer(envKey, bearer)` records the bearer this host will
 * ACCEPT; `recordCallBearer(envKey, bearer)` the one it will SEND. `resolveEnvironment(envKey)` answers
 * `{ ok }` for a known environment, and `revokePairing(envKey)` removes both sides of a pairing.
 */
export function createPairingRoutes({ mintBearer, storeBearer, recordCallBearer, resolveEnvironment, revokePairing, json }) {
  const text = (value) => (typeof value === "string" && value ? value : null);

  return defineRoutes("pairing", [
    {
      key: "POST /api/pair",
      guard: "host-token",
      body: "json",
      refusal: CREATES_A_CREDENTIAL,
      handler: (_req, res, _url, { body }) => {
        const envKey = text(body?.envKey);
        if (!envKey) return json(res, 400, { ok: false, refused: "bad-request", why: "pairing names the environment key it asks to pair with" });
        const bearer = mintBearer();
        storeBearer(envKey, bearer);
        return json(res, 200, { ok: true, envKey, bearer });
      },
    },
    {
      key: "POST /api/pair/complete",
      guard: "host-token",
      body: "json",
      refusal: CREATES_A_CREDENTIAL,
      handler: async (_req, res, _url, { body }) => {
        const envKey = text(body?.envKey);
        const bearer = text(body?.bearer);
        if (!envKey || !bearer) return json(res, 400, { ok: false, refused: "bad-request", why: "pairing completion carries the environment key and the bearer it issued" });
        const target = await resolveEnvironment(envKey);
        if (!target.ok) return json(res, 404, target);
        recordCallBearer(envKey, bearer);
        return json(res, 200, { ok: true, envKey, paired: true });
      },
    },
    {
      key: "DELETE /api/pair",
      guard: "host-token",
      body: "json",
      refusal: refusalFor("revoking a pairing is the host's act and"),
      handler: (_req, res, url, { body }) => {
        const envKey = text(body?.envKey) ?? url.searchParams.get("envKey");
        if (!envKey) return json(res, 400, { ok: false, refused: "bad-request", why: "revoking a pairing names the environment key (envKey)" });
        const result = revokePairing(envKey);
        return json(res, result.ok ? 200 : 404, result);
      },
    },
  ]);
}
