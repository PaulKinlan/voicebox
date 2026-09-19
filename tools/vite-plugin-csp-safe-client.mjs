// tools/vite-plugin-csp-safe-client.mjs — DEV SERVER ONLY.
//
// The page's CSP is strict on purpose: `script-src 'self'` (public/index.html:7).
// Vite's dev client builds its reconnect ping worker from a blob
// (`vite/dist/client/client.mjs` → `waitForSuccessfulPing`), and with no
// `worker-src` the CSP falls back to `script-src 'self'`, so the blob worker is
// blocked:
//
//   Creating a worker from 'blob:http://localhost:5173/<uuid>' violates the
//   following Content Security Policy directive: "script-src 'self'".
//
// The client hits this on every dev-server restart (the `vite:ws:disconnect`
// path), which is why the violation shows up in the console of a page that was
// left open across a restart.
//
// WE DO NOT WIDEN THE CSP. A widened `script-src 'self' blob:` would be visible
// only in a diff while the protection it removes is invisible until something
// exploits it. Instead the client is served with Vite's OWN fallback path taken:
// the inline visibility-manager ping it uses in browsers without SharedWorker.
// No worker, no blob, same behaviour — poll until the server answers, then reload.
//
// Loud on drift (a mechanism that cannot do its job must say so): if the branch
// this plugin patches is no longer present in Vite's source, the dev server
// refuses to start; if it is missing from a served body, the error is logged
// rather than serving a client that will violate the CSP again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BRANCH = 'if (typeof SharedWorker === "undefined") {';
const PATCHED = "if (true) { // csp-safe-vite-client: inline ping (SharedWorker blob blocked by script-src 'self')";

export function cspSafeViteClient() {
  const clientPath = fileURLToPath(new URL("../node_modules/vite/dist/client/client.mjs", import.meta.url));
  return {
    name: "csp-safe-vite-client",
    apply: "serve",
    configureServer(server) {
      const source = readFileSync(clientPath, "utf8");
      if (!source.includes(BRANCH)) {
        throw new Error(
          `csp-safe-vite-client: Vite's SharedWorker branch changed or moved (not in ${clientPath}). ` +
            `Refusing to serve a dev client that would violate the page's script-src 'self' on reconnect — update this plugin.`,
        );
      }
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/@vite/client")) return next();
        const end = res.end.bind(res);
        res.end = (chunk, encoding, callback) => {
          if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return end(chunk, encoding, callback);
          const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          if (!text.includes(BRANCH)) {
            server.config.logger.error(
              "csp-safe-vite-client: the served client no longer contains the SharedWorker branch — " +
                "the reconnect ping will violate script-src 'self' again.",
            );
            return end(chunk, encoding, callback);
          }
          return end(text.replace(BRANCH, PATCHED), encoding, callback);
        };
        next();
      });
      server.config.logger.info("[csp-safe-vite-client] serving Vite's client with the inline ping (no blob worker)");
    },
  };
}
