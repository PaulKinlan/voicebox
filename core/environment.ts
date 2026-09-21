// core/environment.ts — THE ENVIRONMENT DESCRIPTOR: a host you can act in, as data.
//
// WHY THIS FILE EXISTS, and why it is NOT a fourth root kind. The top of the page used to answer
// "the local server answered" — one environment, rendered. Paul asked for a LIST: the browser by
// default, then other servers where a daemon is running, each with a home folder. The root seam
// (`core/root.ts`) already answers "where are the files" for the host that owns them; an environment
// is the HOST, and its home is a root scoped to that host. So the descriptor reuses RootDescriptor
// rather than forking it: a remote server's folders are `machine` roots THERE, and the page never
// compares roots across environments.
//
// THE IDENTITY IS A KEY, NOT A LABEL. A label or an origin is mutable and reusable — a re-paired or
// re-pointed environment would silently inherit another's history. So the identity a pairing and a
// task pin is a self-issued key the host presents at handshake. `label` and `origin` are display and
// dialling, never identity.
//
// THE TWO NAMED ABSENCES, kept distinct because the remedies differ (the same discipline as
// `root-not-declared` vs `root-not-reachable-from-here` one level down):
//
//   environment-list-unreadable  — there IS a registry file, and it could not be read or parsed
//   environment-unreachable      — a listed host did not answer its health check
//
// "There is no list" is the empty state (a fresh server), not an error. "The list could not be read"
// sends a reader to the file; "the host is not there" sends them to the service. Collapsing them is
// how a reader goes looking for the wrong problem.
//
// Pure: no imports, no IO. The store and the probe live one level up (server.mjs), because they are
// the side that touches the filesystem and the network; this file is the shape both sides agree on.

import type { RootDescriptor } from "./root.ts";

export type EnvironmentKind = "browser" | "server" | "fence";

/**
 * A host you can act in. `boundary` and `capability` are OBSERVED, never configured — a descriptor
 * that claims a sandbox it does not enforce is the defect the per-axis probe exists to prevent.
 * They are `null` until the environment has been probed, and the report carries its own `when` so a
 * stale one reads as stale, not current.
 */
export interface EnvironmentDescriptor {
  /** Stable identity: a self-issued key the host presents at handshake. NOT the label. */
  key: string;
  /** Display name — "browser" | "this machine" | "atlas-vm". Mutable, never an identity. */
  label: string;
  kind: EnvironmentKind;
  /** Where the page reaches it. Same-origin for the browser and the local server; an origin for a remote one. */
  origin: string;
  /** This environment's home: a root it owns, scoped to it (core/root.ts, reused not forked). */
  home: RootDescriptor | null;
  /** The measured boundary, per axis, with its `when`. Null until probed. */
  boundary: Record<string, unknown> | null;
  /** The observed capability report: tools, runtimes, agents, with its `when`. Null until probed. */
  capability: Record<string, unknown> | null;
  /** How the page reaches it: ambient (loopback) or paired (a bearer, after pairing). */
  reach: "ambient" | "paired";
  /** When this descriptor was declared (ISO). A hint, not an ordering key. */
  declaredAt: string;
}

// ── the named absences ──────────────────────────────────────────────────────

/** The registry file exists and could not be read or parsed — the reader's remedy is the file. */
export const ENV_LIST_UNREADABLE = "environment-list-unreadable";
/** A listed host did not answer its health check — the reader's remedy is the service. */
export const ENV_UNREACHABLE = "environment-unreachable";

export function listUnreadable(why: string): { ok: false; refused: string; why: string } {
  return {
    ok: false,
    refused: ENV_LIST_UNREADABLE,
    why: `the environment registry could not be read — ${why}. The list lives in a file on the server; ` +
      `fix or remove that file rather than assuming there are no environments`,
  };
}

export function unreachable(label: string, origin: string): { ok: false; refused: string; why: string } {
  return {
    ok: false,
    refused: ENV_UNREACHABLE,
    why:
      `"${label}" (${origin}) did not answer its health check — the environment is listed but the ` +
      `service is not running. Start the service, or remove the environment from the list`,
  };
}

// ── descriptor construction and validation ──────────────────────────────────

export type EnvParseResult =
  | { ok: true; value: Omit<EnvironmentDescriptor, "declaredAt"> }
  | { ok: false; refused: string; why: string };

/**
 * Validate what a "+" post declares. Strict, like every gate in this system: a descriptor is the
 * thing the whole list agrees on, so a malformed one is refused by name rather than stored.
 * `key` is supplied by the caller (the server generates it), so this validates the human half.
 */
export function parseEnvironment(raw: unknown): EnvParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refused: "bad-request", why: "an environment declaration is an object: {label, origin, kind, home?}" };
  }
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  if (!label) return { ok: false, refused: "bad-request", why: "an environment needs a label — the name the list shows" };
  let origin = typeof o.origin === "string" ? o.origin.trim() : "";
  if (o.kind === "server" && !origin) {
    return { ok: false, refused: "bad-request", why: "a server environment needs an origin — where the page reaches it" };
  }
  if (o.kind === "fence") {
    // A fence is BOOTED by the host and given its origin after boot; asking the caller for one would
    // be asking for a value that is always discarded. No origin is required — the boot assigns it.
    origin = "booted-by-host";
  }
  if (o.kind !== "browser" && o.kind !== "server" && o.kind !== "fence") {
    return { ok: false, refused: "unknown-environment-kind", why: `'${String(o.kind)}' is not an environment kind (browser, server, fence)` };
  }
  return {
    ok: true,
    value: {
      key: typeof o.key === "string" ? o.key : "",
      label,
      kind: o.kind,
      origin,
      home: (o.home && typeof o.home === "object" ? (o.home as RootDescriptor) : null),
      boundary: null,
      capability: null,
      reach: o.reach === "paired" ? "paired" : "ambient",
    },
  };
}
