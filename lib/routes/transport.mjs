/**
 * @summary Transport bundles: export the declared machine root as a bundle and import one into it (GET /api/transport/export, POST /api/transport/import), both the host's act.
 */
// Transport routes (voicebox-beads-cwx5.1). A bundle carries the CONTENTS of the declared machine root in one
// direction and writes files INTO it in the other, so neither is a page act:
//
//   * import (voicebox-beads-3dma, TM-WRITE-011/TM-TRANSPORT-022) writes files into the machine's own tree from a
//     bundle whose paths the caller chose;
//   * export (voicebox-beads-c84e) hands back every non-dot file under the root, and the mini-app relay is exactly
//     the kind of caller that can reach loopback.
//
// Both declare the `host-token` guard. An Origin header is a claim any local process can write on a raw socket and
// the in-room session token is served openly in the page HTML, so neither distinguishes a local PROCESS from the
// person at the keyboard. The guard runs before the handler, so a refusal says nothing about what this machine
// holds.
import { defineRoutes } from "./guarded.mjs";

const refusalFor = (act) => ({
  refused: "host-token-required",
  why: `${act} — the host's act. It takes the host token (x-voicebox-host-token); the page cannot hold it, and a bare Origin header is a claim any local process can make.`,
});

/**
 * `getActive()` is the declared root as the host holds it now (`{ root }` or null), `noRootDeclared()` the
 * host's refusal for "nothing declared", and `exportBundle` / `importBundle` are lib/env-transport.mjs's.
 */
export function createTransportRoutes({ getActive, noRootDeclared, exportBundle, importBundle, selfEnvironment, json, contentJsonBodyMaxBytes }) {
  /** The machine root both directions need, or the refusal already sent. */
  const machineRoot = (res, direction) => {
    const active = getActive();
    if (!active) { json(res, 400, { ...noRootDeclared(), root: null }); return null; }
    if (active.root.kind !== "machine" || !active.root.path) {
      json(res, 400, {
        ok: false,
        refused: "root-not-reachable-from-here",
        why: `transport ${direction} the server requires a machine root (active root kind is '${active.root.kind}')`,
        root: active.root,
      });
      return null;
    }
    return active.root;
  };

  return defineRoutes("transport", [
    {
      key: "GET /api/transport/export",
      guard: "host-token",
      refusal: refusalFor("exporting a transport bundle reads the contents of the declared root"),
      handler: (_req, res, url) => {
        const root = machineRoot(res, "export from");
        if (!root) return;
        const rawFiles = url.searchParams.get("files");
        const files = rawFiles ? rawFiles.split(",").map((s) => s.trim()).filter(Boolean) : null;
        const exported = exportBundle(root.path, { files, sourceEnvironment: selfEnvironment, sourceKind: "machine" });
        if (!exported.ok) return json(res, 400, { ...exported, root });
        return json(res, 200, { ok: true, bundle: exported.bundle, root });
      },
    },
    {
      key: "POST /api/transport/import",
      guard: "host-token",
      body: "json",
      maxBytes: contentJsonBodyMaxBytes,
      refusal: refusalFor("importing a transport bundle writes files into the declared root"),
      handler: (_req, res, _url, { body }) => {
        const root = machineRoot(res, "import on");
        if (!root) return;
        const rawBundle = body?.bundle ?? body;
        // OVERWRITE IS EXPLICIT, never assumed (voicebox-beads-3dma): an omitted field used to REPLACE existing
        // files. A bundle that would clobber something is refused by name (`file-exists`) unless the caller
        // says `overwrite: true` in so many words.
        const imported = importBundle(root.path, rawBundle, { overwrite: body?.overwrite === true });
        if (!imported.ok) return json(res, 400, { ...imported, root });
        return json(res, 200, { ...imported, root });
      },
    },
  ]);
}
