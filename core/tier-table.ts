// core/tier-table.ts — the enforcement rows as DATA.
// First matching rule wins; tier 0 refuses; tier 2 asks.
//
// CHANGED for E1-M0: the `outside-root` row hard-coded `v1/projects/atlas`, so the table only
// ever spoke for one project — a second project's writes were "outside the root" by construction
// and the row that decides containment was a constant. A rule that cannot see the root cannot
// decide about it. The root now arrives as the rule context, and `Act.target` is the RESOLVED
// path (root-prefixed, produced by core/paths.resolveInsideRoot), which is what makes the prefix
// comparison in `insideRoot` a comparison rather than a guess.

export type Tier = 0 | 1 | 2;

export type Act = {
  kind: "read" | "write" | "delete" | "exec" | "network" | "import" | "eval" | "external";
  target: string;             // RESOLVED: root-prefixed, the output of resolveInsideRoot
  bytes?: number;
  tool?: string;
};

/** What a rule is allowed to know besides the act: the project it is judging it for. */
export type RuleContext = { root: string };

export type Rule = {
  id: string;
  tier: Tier;
  why: string;
  matches: (a: Act, ctx: RuleContext) => boolean;
};

/**
 * The execution root is the containment boundary. In OPFS there are no
 * symlinks and `..` does not resolve, so the check is a prefix comparison.
 * On the machine placement this becomes a realpath check — same shape.
 */
function insideRoot(root: string, target: string): boolean {
  return target.startsWith(root + "/") || target === root;
}

/**
 * A symlink whose target resolves outside the root. In OPFS there are no
 * symlinks, so this always returns false — the rule is here so the shape
 * does not change when the machine placement arrives.
 */
function isSymlinkOut(_target: string): boolean {
  return false;
}

export const RULES: Rule[] = [
  { id: "outside-root",   tier: 0, why: "the execution root is the only place a tool may touch",
    matches: (a, ctx) => a.target !== "" && !insideRoot(ctx.root, a.target) },
  { id: "symlink-out",    tier: 0, why: "a link whose target resolves outside the root",
    matches: (a) => a.kind === "write" && isSymlinkOut(a.target) },
  { id: "eval-path",      tier: 0, why: "eval is not a tool path (design §1.7)",
    matches: (a) => a.kind === "eval" },
  { id: "absent-capability", tier: 0, why: "this placement has no mechanism for it",
    matches: (a) => !ENFORCEABLE.has(a.kind) },
  { id: "writes-inside",  tier: 1, why: "inside the project, reported, revertible",
    matches: (a) => a.kind === "write" },
  { id: "reads-inside",   tier: 1, why: "reading a project's own files",
    matches: (a) => a.kind === "read" },
  { id: "delete",         tier: 2, why: "not reversible by replay",
    matches: (a) => a.kind === "delete" },
  { id: "leaves-browser", tier: 2, why: "anything that reaches outside the origin",
    matches: (a) => a.kind === "external" || a.kind === "network" },
];

/**
 * The capability map: which act kinds this placement can actually enforce.
 * `exec` and `eval` are deliberately absent — no process exists in a browser
 * origin, so the capability is ABSENT, not denied. A rule that references an
 * absent capability is a description, not an enforcement.
 */
export const ENFORCEABLE = new Map<Act["kind"], "handle-scope" | "import-boundary" | "egress-policy">([
  ["read", "handle-scope"],
  ["write", "handle-scope"],
  ["delete", "handle-scope"],
  ["network", "egress-policy"],
  ["import", "egress-policy"],
  // exec and eval are deliberately absent — no process exists in a browser origin.
]);

// The credential and system rules from the design's §3.2 are STRUCTURALLY
// SATISFIED in a browser origin: there is no ~/.ssh, no process, no privilege.
// They are not rules to implement here — they are notes so nobody re-adds
// them as code.
//
// Credential rules:  no ~ directory to protect
// System rules:      no process to spawn, no shell to reach

// ── THE ABSENT-CAPABILITY REFUSAL (bead voicebox-beads-ho9) ──────────────────────────────────────────────
//
// The tier table says what an act may do. This says what the ENVIRONMENT can actually back up, read from
// the environment's own BoundaryReport — the self-probe it emits — and refuses BY NAME when the measured
// boundary does not provide what the act assumes.
//
// THE SPEC IS THE RECEIPT, NOT THE DESIGN. Every field below is the one a real probe wrote
// (`~/journal/reports/sandbox-survey-20260920/probe-bwrap.json`, 2026-09-20), and reading it changed two
// names: the outbound checks carry `ok`, not `reachable` — only `loopback` uses `reachable` — and a binary
// that RAN carries `value`, while one that is missing carries `error: "<binary>: not present"`. A check
// written from the design would have read a field that does not exist and passed by finding nothing.
//
// TWO WAYS THE BOUNDARY FAILS AN ACT, and they are different sentences:
//   · ABSENT — the mechanism is not there at all ("no process mechanism in this environment").
//   · CONTRADICTED — the mechanism is there when the fence claims it is not: bwrap bounds which binary
//     runs, never what it can do, so a shell that ran inside a fence is a containment claim that is false.
// Both are `absent-capability` — what is missing is the promised deny — and both carry the axis and the
// remedy rather than a bare no.

/** The axes, named as the receipt names them. */
export type BoundaryAxis = "deny-files" | "deny-processes" | "passthrough-network";

/**
 * What the environment measured about itself. Partial by design: a report that cannot answer a question
 * must not be read as answering it (see `decide`'s "not measured" handling).
 */
export type BoundaryReport = {
  filesystem?: {
    home?: string;
    pathEntries?: string[];
    dirs?: Record<string, { listable?: boolean; writable?: { value?: boolean }; error?: string }>;
    canReadPasswd?: { value?: boolean };
    mountsReadable?: { value?: boolean; lines?: number };
  };
  tools?: Record<string, { value?: string; error?: string }>;
  network?: Record<string, { ok?: boolean; reachable?: boolean; error?: string; note?: string }>;
};

export type AbsentCapability = {
  ok: false;
  refused: "absent-capability";
  axis: BoundaryAxis;
  why: string;
  remedy: string;
};

/** Which axis an act's kind leans on. `eval` is a process mechanism in this vocabulary's sense. */
const AXIS_FOR_ACT: Partial<Record<Act["kind"], BoundaryAxis>> = {
  read: "deny-files",
  write: "deny-files",
  delete: "deny-files",
  exec: "deny-processes",
  eval: "deny-processes",
  network: "passthrough-network",
  import: "passthrough-network",
  external: "passthrough-network",
};

// RESIDUAL A (coord's review, round two), decided rather than defaulted:
//
//   · AN INTERPRETER THAT RAN IS AN ACT VERDICT. `sh`/`node`/`python3` running inside a fence that claims to
//     deny processes means the act's own mechanism exists — CONTRADICTED, and the refusal quotes the
//     interpreter.
//   · A WRAPPER THAT RAN IS A FENCE FINDING. `bwrap`/`docker`/`podman` present says something about the
//     FENCE's machinery, not about the act's executability: a fence can carry its own wrapper and still have
//     no shell to run. Treating the two as one list let a report with `bwrap` and `git` — and NO interpreter
//     probed — refuse as CONTRADICTION, quoting the wrapper, while the act's interpreter stayed unmeasured.
//     That is a wrapper-presence accusation standing in for an act verdict, and it is now its own sentence.
const INTERPRETERS = ["sh", "bash", "node", "deno", "python3"];
const WRAPPERS = ["bwrap", "docker", "podman"];
/** Every name this axis depends on being LOOKED FOR, whichever side of the split it sits on. */
const PROCESS_MECHANISMS = [...INTERPRETERS, ...WRAPPERS];
const OUTBOUND_FIELDS = ["outboundTcp443IpLiteral", "outboundTcp80ByName", "cloudMetadataService"];

/**
 * WHAT A PASS MEANS, PER AXIS — the caller is entitled to know before it trusts `ok: true`.
 *
 *   · deny-files and deny-processes VERIFY THE DENY. A claimed deny meeting a path that was READ, or a
 *     binary that RAN, is CONTRADICTED and refused with the measurement quoted. A claimed deny meeting an
 *     unreadable path, or no runnable binary, is satisfied — that is what a pass means here.
 *
 *   · passthrough-network CANNOT BE VERIFIED TODAY, only contradicted. Egress that is ALIVE is refused (the
 *     claim is contradicted). Egress that is DEAD is refused TOO, and that is the point: "did not reach"
 *     conflates DENIED-BY-BOUNDARY with BROKEN-AND-DIDN'T-REACH. Measured on the only real fence we have —
 *     its DNS was broken at probe time (EAI_AGAIN), so the report could not tell a closed door from a
 *     missing resolver, and the same fence reached out on port 80 BY NAME once DNS worked. A network pass
 *     needs a probe that distinguishes denied from broken (an IP-literal control beside the name lookup);
 *     until one exists this axis refuses in both directions and says which one it saw.
 *
 * Every branch below is therefore a statement about a MEASUREMENT, and the refusal quotes the field that
 * fired — never a different field that happens to be in the same report.
 */
/**
 * Decide whether the MEASURED boundary covers this act.
 *
 * Returns `{ ok: true, axis, why }` when the environment can back the act, or the named refusal when it
 * cannot — never a bare `false`, and never a silent pass: an axis that was NOT MEASURED is not a pass,
 * because "we did not look" and "we looked and it was denied" are different facts (the shared-log rule,
 * applied to a boundary).
 */
export function decide(report: BoundaryReport, act: Act): { ok: true; axis: BoundaryAxis; why: string } | AbsentCapability {
  const axis = AXIS_FOR_ACT[act.kind];
  if (!axis) {
    // A kind with no axis is a table that has not been extended — say so in the vocabulary's terms rather
    // than letting the act through on a technicality.
    return {
      ok: false,
      refused: "absent-capability",
      axis: "deny-files",
      why: `no boundary axis is mapped for act kind '${act.kind}', so the measured report cannot cover it`,
      remedy: "extend AXIS_FOR_ACT in core/tier-table.ts and re-probe — an unmapped act is a gap in the table, not a permission",
    };
  }

  if (axis === "deny-processes") {
    // 1. THE ACT VERDICT: an INTERPRETER ran.
    const interpretersRan = INTERPRETERS.filter((name) => typeof report.tools?.[name]?.value === "string");
    if (interpretersRan.length > 0) {
      const first = interpretersRan[0];
      const version = String(report.tools?.[first]?.value ?? "").split("\n")[0].slice(0, 60);
      return {
        ok: false,
        refused: "absent-capability",
        axis,
        why:
          `this environment claims processes are denied, and its own probe shows an INTERPRETER ran: ` +
          `tools.${first}.value = ${JSON.stringify(version)}${interpretersRan.length > 1 ? ` (and ${interpretersRan.length - 1} more)` : ""}. ` +
          `The deny is not in force, so an act that assumes a process boundary would run unbounded.`,
        remedy:
          "do not rely on a process deny this fence does not provide: bwrap bounds which binary runs, not what it can do. " +
          "The fence must deny the interpreter (sh/node/python) rather than the wrapper, or the act must run in an " +
          "environment whose report shows no interpreter at all.",
      };
    }

    // 2. THE FENCE FINDING: a WRAPPER ran and the interpreter was never probed. This is a statement about the
    //    fence, not a verdict on the act — so it must not read like one.
    const interpretersLookedFor = INTERPRETERS.filter((name) => report.tools?.[name] !== undefined);
    const wrappersRan = WRAPPERS.filter((name) => typeof report.tools?.[name]?.value === "string");
    if (interpretersLookedFor.length === 0 && wrappersRan.length > 0) {
      const first = wrappersRan[0];
      const version = String(report.tools?.[first]?.value ?? "").split("\n")[0].slice(0, 60);
      return {
        ok: false,
        refused: "absent-capability",
        axis,
        why:
          `a FENCE finding, not an act verdict: the report shows a wrapper ran (tools.${first}.value = ` +
          `${JSON.stringify(version)}) while NONE of the interpreters this act depends on was probed ` +
          `(${INTERPRETERS.join(", ")}). A fence can carry its own wrapper and still have no shell, so the ` +
          `act's executability is UNMEASURED — and a wrapper-presence accusation must not stand in for it.`,
        remedy:
          "the fence provider must probe the interpreters (sh/node/python3/…) rather than only its own wrapper: " +
          "until it does, this axis cannot say whether the act could run, only that the fence's machinery is present.",
      };
    }
    const lookedFor = PROCESS_MECHANISMS.filter((name) => report.tools?.[name] !== undefined);
    if (lookedFor.length === 0 && report.tools && Object.keys(report.tools).length > 0) {
      return {
        ok: false,
        refused: "absent-capability",
        axis,
        why:
          `this environment's report lists tools but none of the mechanisms this axis depends on ` +
          `(${PROCESS_MECHANISMS.slice(0, 6).join(", ")}…), so whether a process mechanism exists here is ` +
          `unmeasured — and a tool list that did not look is not a denial.`,
        remedy: "the self-probe must attempt each process mechanism and record it (value when it ran, error when it is absent); re-probe before assuming a process boundary",
      };
    }
    const measured = report.tools && Object.keys(report.tools).length > 0;
    if (!measured) {
      return {
        ok: false,
        refused: "absent-capability",
        axis,
        why: "this environment's report carries no `tools` measurement, so whether it has a process mechanism is unmeasured — and unmeasured is not denied",
        remedy: "the self-probe must report the tools it looked for (present with `value`, absent with `error`); re-probe before assuming a process boundary",
      };
    }
    return {
      ok: false,
      refused: "absent-capability",
      axis,
      why: `no process mechanism in this environment: every tool in the report is absent (${Object.keys(report.tools ?? {}).slice(0, 4).join(", ")}…), so there is nothing here to run the act with`,
      remedy: "run it where the report shows exec — an environment whose tools carry `value` rather than `error`",
    };
  }

  if (axis === "passthrough-network") {
    const reached = OUTBOUND_FIELDS.filter((field) => {
      const m = report.network?.[field];
      return m?.ok === true || m?.reachable === true;
    });
    if (reached.length > 0) {
      const first = reached[0];
      const detail = report.network?.[first];
      return {
        ok: false,
        refused: "absent-capability",
        axis,
        why:
          `this environment claims the network is bounded, and its own probe REACHED out: network.${first} = ` +
          `${JSON.stringify({ ok: detail?.ok, ms: detail?.ms })}${first === "cloudMetadataService" ? " — the metadata service answered, so credentials may be reachable" : ""}`,
        remedy:
          "an egress policy, not a hint: deny the egress at the fence (or run the act where the report shows the " +
          "outbound checks timing out), because a bounded-network claim that the probe contradicts is not a boundary.",
      };
    }
    const measuredAny = OUTBOUND_FIELDS.some((field) => report.network?.[field] !== undefined);
    if (!measuredAny) {
      return {
        ok: false,
        refused: "absent-capability",
        axis,
        why: "this environment's report carries no outbound measurement, so the network boundary is unmeasured — and unmeasured is not bounded",
        remedy: "the self-probe must attempt the outbound checks and record them (ok: false with an error, or ok: true); re-probe before assuming a bounded network",
      };
    }
    // FIX 3 — THE POLARITY, decided as CONTAINMENT (coord, 2026-09-21). "Did not reach anything" is NOT a
    // network boundary: it conflates DENIED-BY-BOUNDARY with BROKEN-AND-DIDN'T-REACH. Measured on the only
    // real fence we have: its DNS was BROKEN at probe time (EAI_AGAIN on the by-name check), and the same
    // fence went on to REACH OUT on port 80 by name once DNS worked. A tier claiming a bounded network,
    // meeting a dead egress, is therefore not verified — it is unmeasured by brokenness, and it says so.
    const deadEvidence = OUTBOUND_FIELDS.map(
      (field) => `${field}: ${report.network?.[field]?.error ?? `ok=${String(report.network?.[field]?.ok)}`}`,
    ).join("; ");
    const dnsBroke = OUTBOUND_FIELDS.some((field) => /EAI_AGAIN|ENOTFOUND|getaddrinfo|DNS/i.test(String(report.network?.[field]?.error ?? "")));
    return {
      ok: false,
      refused: "absent-capability",
      axis,
      why:
        `this environment claims the network is bounded, and its own probe could not tell a closed door from a ` +
        `broken resolver: nothing was reached (${deadEvidence}), so the claim is UNVERIFIED rather than ` +
        `satisfied${dnsBroke ? " — and the failure is name resolution, which is brokenness, not a fence: the same fence reached out by name once DNS worked" : ""}.`,
      remedy:
        "re-probe with a working resolver AND an IP-literal control beside the name lookup, so 'denied' and " +
        "'broken' are distinguishable; until a probe can tell them apart this axis is not verifiable and the " +
        "act belongs where a fence's egress policy is measured directly.",
    };
  }

  // deny-files
  const fs = report.filesystem ?? {};
  const home = typeof fs.home === "string" ? fs.home : null;
  const homeLabel = home === null ? "(no home reported)" : JSON.stringify(home);

  // FIX 2a: EVERY SUB-MEASUREMENT THE DENY DEPENDS ON must exist. An axis-level "unmeasured is not denied"
  // was not enough — a report could carry `mounts` and `dirs` and say nothing about passwd readability, and
  // the axis passed on the strength of the fields that happened to be present.
  const missing: string[] = [];
  if (fs.mountsReadable === undefined) missing.push("filesystem.mountsReadable");
  if (fs.canReadPasswd === undefined) missing.push("filesystem.canReadPasswd");
  if (home === null || fs.dirs?.[home] === undefined) missing.push(`filesystem.dirs[${homeLabel}]`);
  if (missing.length > 0) {
    return {
      ok: false,
      refused: "absent-capability",
      axis,
      why:
        `this environment's report does not measure ${missing.join(", ")}, so the file boundary is unmeasured ` +
        `in the place the act depends on it — and unmeasured is not scoped.`,
      remedy:
        "the self-probe must report every field this axis reads (mountsReadable, canReadPasswd, and the home " +
        "directory's listable/writable halves); re-probe before assuming a scoped root.",
    };
  }

  // FIX 1: THE EVIDENCE LINE QUOTES THE FIELD THAT FIRED. It used to OR `listable` with `writable` and then
  // print `listable = true` — naming a measurement that was FALSE when only the writable half fired. A
  // refusal whose evidence misreports its own trigger is this bead's defect class, inside the refusal.
  const fileTriggers: string[] = [];
  if (fs.mountsReadable?.value === true) {
    fileTriggers.push(`filesystem.mountsReadable = true across ${fs.mountsReadable?.lines ?? "?"} mount lines`);
  }
  if (fs.dirs?.[home as string]?.listable === true) {
    fileTriggers.push(`filesystem.dirs[${homeLabel}].listable = true`);
  }
  if (fs.dirs?.[home as string]?.writable?.value === true) {
    fileTriggers.push(`filesystem.dirs[${homeLabel}].writable.value = true (the writable half, not the listing half)`);
  }
  if (fs.canReadPasswd?.value === true) {
    fileTriggers.push("filesystem.canReadPasswd.value = true — /etc/passwd was readable");
  }
  if (fileTriggers.length > 0) {
    return {
      ok: false,
      refused: "absent-capability",
      axis,
      why:
        `this environment claims files are scoped, and its own probe found the opposite: ` +
        `${fileTriggers.join("; ")}. A readable (or writable) path outside the act's root is not a deny.`,
      remedy:
        "scope the root: bind only the act's root into the fence, or run the act where the report shows " +
        "mountsReadable false and the home directory neither listable nor writable.",
    };
  }
  return { ok: true, axis, why: "the report shows no readable path outside the act's root" };
}
