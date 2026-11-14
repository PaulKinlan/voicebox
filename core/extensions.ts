// core/extensions.ts — the extension admission gate as DATA + pure functions.
//
// The design (docs/02-environment.md §1.7): a capability is not a permission a
// tool claims; it is the interface the tool is GIVEN. Admission therefore asks
// one question per declared capability — WHICH NAMED MECHANISM ENFORCES IT
// HERE? — and refuses, by name, when the answer is none. A declaration is an
// audit record and a request, never the thing that makes an act safe.
//
// This module is pure: no IO, no imports, no placement knowledge beyond the
// tables below. The same code runs in the server process and in a page worker
// (N18). lib/extensions.mjs owns the directories, the registry and the
// runtime; this file owns the DECISION.
//
// Zero dependencies, by design: the runtime stays zero-dependency, and so does
// the vocabulary it decides with.

// ── the vocabulary ─────────────────────────────────────────────────────────

export type Capability = "read" | "write" | "delete" | "network" | "exec" | "eval" | "import";

export type Placement = "browser" | "machine";

/** Bounds are the "how much" fields (rsj): a network tool must say WHERE and HOW MUCH. */
export type Bounds = {
  hosts?: string[]; // network: exactly which hosts, checked at admit AND at call
  maxRequests?: number; // network: the request budget, counted by the host at call
  maxBytes?: number; // write: the per-call write budget
};

/**
 * The closed set of primitives (docs/06 §1.4(2)): `execute` is code and a
 * model cannot emit code as data, so the verbs are a FIXED repertoire the
 * model parameterises, not bodies it writes. There is no fourth door: a
 * descriptor whose tool names something outside this set is refused, because
 * the host would have to evaluate model-authored code to run it.
 */
export type Primitive = "now" | "read-file" | "write-file" | "list-files" | "http-get" | "wasm";

export const PRIMITIVES: readonly Primitive[] = ["now", "read-file", "write-file", "list-files", "http-get", "wasm"];

/** What each primitive CONSUMES — the needs a descriptor must declare to use it. */
export const PRIMITIVE_NEEDS: Record<Primitive, Capability[]> = {
  now: [],
  "read-file": ["read"],
  "write-file": ["write"],
  "list-files": ["read"],
  "http-get": ["network"],
  // wasm CONSUMES NO CAPABILITY: its imports are a closed, declared set (buffer-abi/1: ZERO
  // imports). That is the answer to the closed set's own refusal: `execute` was refused because
  // 'there is no mechanism'; a verified-digest module with no imports IS the mechanism
  // (voicebox-beads-4vz, provider-under-gate). BUT the closure is over CAPABILITIES, never over
  // RESOURCES (vb-resolver's review, driven): an export runs synchronously with no fuel and
  // memory.grow needs no import — an admitted module is trusted for its time and memory, and
  // neither is bounded. The digest binds bytes, never behavior.
  wasm: [],
};

/** The wasm asset a 'wasm' tool must carry: the digest its bytes are checked against, and the ABI
 *  as DATA. A digest binds bytes to a manifest — the authority is the host's admission, and the
 *  call-time rehash binds the bytes about to execute to what was admitted (the shelf directory is
 *  mutable as this user, which is the fact that makes the second check non-redundant). */
export interface WasmAsset {
  path: string; // the module file, read and rehashed at EVERY call
  digest: string; // /^[0-9a-f]{64}$/ — the sha256 the host admitted
  abi: string; // the driven families: "buffer-abi/1" | "buffer-abi/diff"
  input?: { addr: number; maxBytes: number };
  inputA?: { addr: number; maxBytes: number };
  inputB?: { addr: number; maxBytes: number };
  output: { addr: number; bytes?: number; maxBytes?: number };
  call: { export: string }; // function export to invoke
}

export interface ToolSpec {
  name: string; // /^[a-z0-9_]+$/ — pi's dynamic-tools.ts rule
  description: string;
  promptSnippet?: string; // pi's lesson (docs/06 §1.1): without it the tool is invisible in the prompt
  primitive: Primitive;
  params: Record<string, string | number | boolean>;
  wasm?: WasmAsset; // REQUIRED when primitive is 'wasm', absent otherwise
}

export interface ExtensionDescriptor {
  id: string; // /^[a-z0-9_-]+$/
  name: string;
  description: string;
  source: "model" | "catalogue" | "builtin" | "local" | "sideload";
  /** Where the tool's work happens. "process" means the model authored a LAUNCH. */
  runsIn: "host" | "process" | "remote";
  capabilities: Capability[];
  bounds: Bounds;
  tools: ToolSpec[];
}

// ── the enforcement tables ─────────────────────────────────────────────────
//
// The machine column is written from the measured results in
// docs/02-environment.md §1.7, not from optimism: exec was falsified four ways
// (a spawned /bin/sh read a secret even under narrow --allow-run), import is
// live by default in node, and eval bypasses every substrate bound. A
// capability absent from a placement's table is ABSENT, not denied.

export const MECHANISMS: Record<Placement, Partial<Record<Capability, string>>> = {
  browser: {
    read: "handle-scope",
    write: "handle-scope",
    delete: "handle-scope",
    network: "csp-connect-src", // realm egress policy, default 'none'
    import: "csp-script-src",
  },
  machine: {
    read: "host-primitive-scope", // the tool is handed root-scoped IO functions, not a filesystem
    write: "host-primitive-scope",
    delete: "host-primitive-scope",
    network: "mediated-fetch", // the tool is handed a host fetch that refuses unlisted hosts and counts the budget
    // exec: absent — "--allow-run bounds which binary, never what it can do"
    // import: absent — dynamic import executes fetched code with no flags by default
    // eval: absent — the evaluator bypasses every substrate bound
  },
};

/** Why a capability is absent, where absence has a measured reason. */
export const ABSENT_WHY: Partial<Record<Capability, string>> = {
  exec: "no mechanism on this placement bounds a spawned child: --allow-run bounds which binary, never what it can do, and a child does not inherit the parent's flags. Admission requires a container that bounds the child.",
  eval: "eval is not a tool path (design §1.7): the evaluator bypasses whatever the substrate would otherwise enforce.",
  import: "no import boundary on this placement: dynamic import executes fetched code with no flags by default.",
};

/** What the host hands a tool for each admitted capability — the disclosure's "what it will be given". */
export const GETS: Partial<Record<Capability, string>> = {
  read: "a root-scoped read function: paths resolve inside the project root or refuse",
  write: "a root-scoped write function: paths resolve inside the project root, writes are reported and revertible",
  delete: "a root-scoped delete function (tier 2 — asks first)",
  network: "a mediated fetch: hosts outside bounds.hosts are refused by name — INCLUDING across redirects, every hop charged to bounds.maxRequests — and the audit records the URL that actually served the bytes",
};

// ── the gate ───────────────────────────────────────────────────────────────

export type Admission =
  | {
      decision: "admitted";
      enforced: Partial<Record<Capability, string>>; // declared -> the mechanism that makes it true
      gets: string[]; // what the host will hand the tool
      cannotHave: string[]; // what this placement cannot grant even if asked
    }
  | {
      decision: "refused";
      rule: string; // the named rule — the artefact a refusal drive exists to produce
      why: string;
      gets: string[];
      cannotHave: string[];
    };

const CAPABILITY_SET: ReadonlySet<string> = new Set([
  "read",
  "write",
  "delete",
  "network",
  "exec",
  "eval",
  "import",
]);

const MEDIATED_CAPS: ReadonlySet<Capability> = new Set(["read", "write", "network"]);

function cannotHaveFor(placement: Placement): string[] {
  const out: string[] = [];
  for (const cap of ["exec", "eval", "import"] as Capability[]) {
    if (!MECHANISMS[placement][cap]) {
      out.push(`${cap} — absent: ${ABSENT_WHY[cap] ?? "no enforcement mechanism on this placement"}`);
    }
  }
  return out;
}

/**
 * admit(descriptor, placement, existingToolNames) — the one door.
 *
 * First failing rule wins; every refusal carries a rule id and a why, because
 * "the refusal with its named reason is the artefact". The same function
 * decides for a model-authored proposal and for a user's sideload (N16: one
 * admission point; two doors would mean two policies and the weaker one wins).
 */
export function admit(
  descriptor: ExtensionDescriptor,
  placement: Placement,
  existingToolNames: ReadonlySet<string> = new Set(),
): Admission {
  const cannotHave = cannotHaveFor(placement);

  const caps = descriptor.capabilities ?? [];
  for (const cap of caps) {
    if (!CAPABILITY_SET.has(cap)) {
      return { decision: "refused", rule: "unknown-capability", why: `'${cap}' is not in the capability vocabulary`, gets: [], cannotHave };
    }
    if (cap === "eval") {
      return { decision: "refused", rule: "eval-not-a-tool-path", why: ABSENT_WHY.eval!, gets: [], cannotHave };
    }
    if (cap === "exec") {
      return { decision: "refused", rule: "exec-absent", why: ABSENT_WHY.exec!, gets: [], cannotHave };
    }
    if (cap === "import") {
      // Even where the placement names a mechanism (browser CSP), the closed
      // primitive set has no import verb: there is nothing the host could
      // hand the tool that would mediate it. Unmediated means ungrantable.
      return {
        decision: "refused",
        rule: "capability-unmediated",
        why: "no primitive in the closed set mediates 'import': a tool that wants to load code is asking for authority the host cannot hand it as an interface",
        gets: [],
        cannotHave,
      };
    }
    if (!MEDIATED_CAPS.has(cap)) {
      return {
        decision: "refused",
        rule: "capability-unmediated",
        why: `no primitive in the closed set mediates '${cap}' — add a primitive with a named mechanism before tools can ask for it`,
        gets: [],
        cannotHave,
      };
    }
  }

  // "process" is the model authoring a LAUNCH, not a function (rsj): a
  // strictly larger authority question than registration, refused wherever no
  // mechanism bounds the child.
  if (descriptor.runsIn === "process") {
    return {
      decision: "refused",
      rule: "exec-absent",
      why: `runsIn: "process" means the host would launch a child process — ${ABSENT_WHY.exec}`,
      gets: [],
      cannotHave,
    };
  }

  const wantsNetwork = caps.includes("network");
  if (wantsNetwork && (!descriptor.bounds?.hosts || descriptor.bounds.hosts.length === 0 || !descriptor.bounds?.maxRequests)) {
    return {
      decision: "refused",
      rule: "network-unbounded",
      why: "a network capability must say where (bounds.hosts) and how much (bounds.maxRequests) — an unbounded declaration is not a bound",
      gets: [],
      cannotHave,
    };
  }

  if (!Array.isArray(descriptor.tools) || descriptor.tools.length === 0) {
    return { decision: "refused", rule: "no-tools", why: "an extension carries at least one tool", gets: [], cannotHave };
  }

  const seen = new Set<string>();
  for (const tool of descriptor.tools) {
    if (!/^[a-z0-9_]+$/.test(tool.name ?? "")) {
      return { decision: "refused", rule: "bad-tool-name", why: `tool name '${tool.name}' is not /^[a-z0-9_]+$/`, gets: [], cannotHave };
    }
    if (!PRIMITIVES.includes(tool.primitive)) {
      return {
        decision: "refused",
        rule: "unknown-primitive",
        why: `primitive '${tool.primitive}' is not in the closed set (${PRIMITIVES.join(", ")}) — running it would mean evaluating model-authored code, and there is no mechanism for that`,
        gets: [],
        cannotHave,
      };
    }
    // An undeclared need cannot be granted (§1.7): the primitive consumes a
    // capability the descriptor did not declare. Under-declaration is caught
    // here, at the gate, not by trust at runtime.
    const undeclared = PRIMITIVE_NEEDS[tool.primitive].filter((need) => !caps.includes(need));
    if (undeclared.length > 0) {
      return {
        decision: "refused",
        rule: "under-declared",
        why: `tool '${tool.name}' uses primitive '${tool.primitive}' which consumes ${undeclared.join(", ")} — declare what the tool consumes; an undeclared need cannot be granted`,
        gets: [],
        cannotHave,
      };
    }
    if (tool.primitive === "wasm") {
      // The asset class (voicebox-beads-qph): a wasm tool without its digest is a module nobody
      // can check — under-declared, because a digest binds bytes to a manifest and nothing else does.
      const w = tool.wasm;
      if (!w || typeof w.path !== "string" || w.path.length === 0) {
        return { decision: "refused", rule: "under-declared", why: `tool '${tool.name}' uses primitive 'wasm' but carries no module path — the asset is the thing the digest binds`, gets: [], cannotHave };
      }
      if (typeof w.digest !== "string" || !/^[0-9a-f]{64}$/.test(w.digest)) {
        return { decision: "refused", rule: "under-declared", why: `tool '${tool.name}' uses primitive 'wasm' but carries no 64-hex digest — a module nobody can verify is a module nobody admitted`, gets: [], cannotHave };
      }
      if (w.abi !== "buffer-abi/1" && w.abi !== "buffer-abi/diff") {
        return { decision: "refused", rule: "unsupported-abi", why: `tool '${tool.name}' declares abi '${w.abi}' — the driven families are 'buffer-abi/1' and 'buffer-abi/diff'; an ABI nobody drives is not a mechanism`, gets: [], cannotHave };
      }
      if (w.abi === "buffer-abi/1") {
        for (const [label, value] of [["input.addr", w.input?.addr], ["input.maxBytes", w.input?.maxBytes], ["output.addr", w.output?.addr], ["output.bytes", w.output?.bytes]] as const) {
          if (!Number.isInteger(value) || (value as number) < 0) {
            return { decision: "refused", rule: "under-declared", why: `tool '${tool.name}' has a wasm asset whose ${label} is ${value} — the ABI is data, declared exactly`, gets: [], cannotHave };
          }
        }
      } else if (w.abi === "buffer-abi/diff") {
        for (const [label, value] of [["inputA.addr", w.inputA?.addr], ["inputA.maxBytes", w.inputA?.maxBytes], ["inputB.addr", w.inputB?.addr], ["inputB.maxBytes", w.inputB?.maxBytes], ["output.addr", w.output?.addr], ["output.maxBytes", w.output?.maxBytes]] as const) {
          if (!Number.isInteger(value) || (value as number) < 0) {
            return { decision: "refused", rule: "under-declared", why: `tool '${tool.name}' has a wasm asset whose ${label} is ${value} — the ABI is data, declared exactly`, gets: [], cannotHave };
          }
        }
      }
      if (typeof w.call?.export !== "string" || w.call.export.length === 0) {
        return { decision: "refused", rule: "under-declared", why: `tool '${tool.name}' names no export to call — the ABI is data, declared exactly`, gets: [], cannotHave };
      }
    }
    if (seen.has(tool.name) || existingToolNames.has(tool.name)) {
      return { decision: "refused", rule: "duplicate-tool", why: `tool name '${tool.name}' is already registered`, gets: [], cannotHave };
    }
    seen.add(tool.name);
  }

  const enforced: Partial<Record<Capability, string>> = {};
  const gets: string[] = [];
  if (descriptor.tools.some((t) => t.primitive === "wasm")) {
    // The admission plan is the surface a person reads BEFORE deciding — so it names what the
    // mechanism binds and what it merely trusts, in the same place it names what it enforces.
    gets.push("wasm: the digest binds BYTES, never behavior — time is bounded by the host's call deadline, memory by the worker's resource limits, the module file by the host's read bound (host constants, not admission data); behavior within those bounds is trusted, and call fan-out is bounded only by the host's turns (N parallel turns hold N workers for the deadline)");
  }
  for (const cap of caps) {
    const mechanism = MECHANISMS[placement][cap];
    if (!mechanism) {
      // The tables above promise every MEDIATED_CAPS entry on both placements;
      // this is the fail-closed backstop, kept because the tables are data.
      return { decision: "refused", rule: "absent-capability", why: `'${cap}' has no enforcement mechanism on the ${placement} placement — absent, not denied`, gets: [], cannotHave };
    }
    enforced[cap] = mechanism;
    gets.push(`${cap}: ${GETS[cap]}`);
  }

  return { decision: "admitted", enforced, gets, cannotHave };
}
