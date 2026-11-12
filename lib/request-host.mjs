/**
 * @summary The Host allowlist: which names a request may address this server by, so a website that rebinds its DNS to loopback is refused before any route runs.
 */
// THE SERVER ANSWERS ONLY TO ITS OWN NAMES (voicebox-beads-cwx5).
//
// Voicebox binds 127.0.0.1, and that was treated as the boundary against the web. It is not one. A page at
// `http://attacker.example:8787` can re-point `attacker.example` at 127.0.0.1 after it loads (DNS rebinding);
// the browser then sends that page's requests to this server and considers them SAME-ORIGIN. They carry a JSON
// Content-Type, `Sec-Fetch-Site: same-origin` and a matching Origin, so the JSON door and the browser-mutation
// check both pass — measured: `POST /api/exec` with `Host: evil.example:<port>` ran a shell command.
//
// The one thing such a request cannot fake is the name it was sent to: the browser writes the Host header from
// the URL, and that URL is the attacker's name, not loopback. So every request and every WebSocket upgrade is
// checked against the names this server is actually reached by, before anything else:
//
//   127.0.0.1   localhost   [::1]      on ANY port: the server's own page, and the Vite dev front, which
//                                      forwards the Host the browser addressed and may sit on any free port
//   any IP literal                     the dev front reached by LAN or tailnet address. A rebinding page is addressed
//                                      by a NAME; a URL with an IP in it is served by whatever is at that IP
//   *.ts.net                           Tailscale Serve in front of the dev server. The same choice vite.config.js
//                                      makes in `allowedHosts`: those names are issued by Tailscale and resolve
//                                      to tailnet addresses, so a web page cannot re-point one at loopback
//   VOICEBOX_ALLOWED_HOSTS=name[:port],…  any other front the operator put in place (a tunnel, a reverse proxy)
//
// The port is deliberately not compared for the loopback names. A rebinding page is, by construction, addressed
// by the ATTACKER'S name; a request whose Host is a literal loopback name came from a page that was itself
// loaded from loopback, and what such a page may do cross-origin is the browser-mutation check's question, as
// it always was.
//
// A raw-socket caller can write any Host it likes; this gate is not a credential and does not pretend to be. It
// is the boundary against a BROWSER being steered here by a name the operator never chose.
//
// This file is pure: no network, no process state.

/** A Host header value as `host[:port]`, lower-cased, or null when it is not one. */
export function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  // host or [ipv6], optional port. No userinfo, no path, no spaces, no commas (a joined duplicate header).
  if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/.test(host)) return null;
  return host;
}

/** `VOICEBOX_ALLOWED_HOSTS` as a list of normalised hosts plus the entries that were refused. */
export function parseAllowedHosts(raw) {
  const hosts = [];
  const refused = [];
  for (const entry of String(raw ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const host = normalizeHost(entry);
    if (host) hosts.push(host); else refused.push(entry);
  }
  return { hosts, refused };
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A dotted IPv4 address or a bracketed IPv6 one. Never a name, so never something DNS can re-point. */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/;
/** The name part of a normalised `host[:port]`. */
const nameOf = (host) => (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]);

/** The gate. `extraHosts` are `host[:port]` strings the operator configured; they match exactly. */
export function createHostGate({ extraHosts = [] } = {}) {
  const fixed = new Set(extraHosts.map(normalizeHost).filter(Boolean));
  return {
    allowed(hostHeader) {
      const host = normalizeHost(hostHeader);
      if (!host) return false;
      const name = nameOf(host);
      return LOOPBACK_NAMES.has(name) || IP_LITERAL.test(name) || name.endsWith(".ts.net") || fixed.has(host);
    },
    /** The refusal every disallowed request gets. The offered name is NOT echoed: it is the attacker's to choose. */
    refusal() {
      return {
        ok: false,
        refused: "host-not-allowed",
        why: "this server answers only when addressed by localhost, an IP address or a Tailscale (.ts.net) name. If you reach it through another hostname, start it with VOICEBOX_ALLOWED_HOSTS=<host[:port]>.",
      };
    },
  };
}
