// core/tier-table.ts — the enforcement rows as DATA.
// First matching rule wins; tier 0 refuses; tier 2 asks.

export type Tier = 0 | 1 | 2;

export type Act = {
  kind: "read" | "write" | "delete" | "exec" | "network" | "import" | "eval" | "external";
  target: string;             // resolved, relative to the project root
  bytes?: number;
  tool?: string;
};

export type Rule = {
  id: string;
  tier: Tier;
  why: string;
  matches: (a: Act) => boolean;
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
    matches: (a) => a.target !== "" && !insideRoot("v1/projects/atlas", a.target) },
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
