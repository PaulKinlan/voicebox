// lib/harness-startup.mjs — the startup validation pass for configured agents (voicebox-beads-aaj)
//
// WHY THIS FILE EXISTS: configured agents were validated only at DELEGATE time — a machine with
// a broken or missing adapter looked healthy until someone delegated, and nothing at boot named
// what would refuse. This pass walks every configured agent in this environment, asks the
// adapter's own describe function what an actual delegation would hit, and reports admission
// as a TABLE: one row per agent, admitted or refused by name, with the remedy. A broken agent
// is registered and visible with its refusal — never silently dropped, and never fatal to the
// server (a harness that cannot run must not take the voice server down with it).
//
// The pass is PURE: the adapter probe is injected, so unit tests feed a stub and the server
// feeds the executor's own describeAdapterInstall. No I/O here beyond what the probe does.

import { publicAgentProjection } from "./harness-config.mjs";

/**
 * The admission verdict for ONE configured agent — the same answer at boot and at query
 * time (voicebox-beads-aaj): what a delegation to this agent would do TODAY.
 */
export function describeAgentAdmission(agent, { describeAdapter, implementedAdapters = new Set(["pi-acp"]), executorSelected = true }) {
  if (!executorSelected) {
    return {
      admitted: false,
      refused: "executor-unavailable",
      why: "no task harness was selected at boot — set VOICEBOX_HARNESS=pi (the same refusal a delegate would get)",
    };
  }
  const adapter = agent.adapter ?? agent.harness;
  if (!implementedAdapters.has(adapter)) {
    return {
      admitted: false,
      refused: "adapter-not-configured",
      why: `No Voicebox task adapter is implemented for '${adapter}' on this host; the agent is configured but cannot run.`,
    };
  }
  const described = describeAdapter(agent);
  if (!described.ok) {
    return {
      admitted: false,
      refused: described.refused ?? "adapter-unavailable",
      why: described.why ?? "the adapter install did not verify",
    };
  }
  return { admitted: true, refused: null, why: null, installedVersion: described.installedVersion ?? null };
}

/**
 * Validate every configured agent of one environment.
 *
 * @param {object} args
 * @param {object} args.registry            the configured-agent registry (lib/harness-config.mjs)
 * @param {string} args.environment         the environment key whose agents are admitted here ("local")
 * @param {(agent: object) => object} args.describeAdapter
 *     per-agent adapter probe: returns { ok, refused?, why?, installedVersion? } — for pi-acp,
 *     describeAdapterInstall bound to the agent's resolved adapterDir.
 * @param {Set<string>} [args.implementedAdapters]  adapters with a real executor installed.
 *     Adapters outside this set refuse `adapter-not-configured` (honest: no adapter exists).
 * @param {boolean} [args.executorSelected]  whether THIS boot selected a task harness at all
 *     (VOICEBOX_HARNESS). When false, nothing is admittable and every row refuses
 *     `executor-unavailable` — the same name, and the same remedy, the delegate path gives.
 * @returns {{ rows: object[], admitted: number, refused: number }}
 *     rows: [{ agent, projection, admitted, refused, why }] — projection is secret-free.
 */
export function validateHarnessAgents({ registry, environment, describeAdapter, implementedAdapters = new Set(["pi-acp"]), executorSelected = true }) {
  if (!registry || typeof registry.list !== "function") {
    throw new TypeError("validateHarnessAgents: registry.list is required");
  }
  if (typeof describeAdapter !== "function") {
    throw new TypeError("validateHarnessAgents: describeAdapter is required");
  }
  const agents = registry.list({ environmentKey: environment });
  const rows = agents.map((agent) => {
    const verdict = describeAgentAdmission(agent, { describeAdapter, implementedAdapters, executorSelected });
    return {
      agent,
      projection: publicAgentProjection(agent),
      ...verdict,
    };
  });
  return {
    rows,
    admitted: rows.filter((r) => r.admitted).length,
    refused: rows.filter((r) => !r.admitted).length,
  };
}

/**
 * The console table, in the server's startup style. Returns LINES; the caller prints them
 * so the pass never assumes a console exists (tests assert strings, not stdout).
 */
export function renderHarnessTable(rows, { environment } = {}) {
  const lines = [];
  lines.push(`  configured agents for environment '${environment ?? "local"}' — admission at boot:`);
  if (rows.length === 0) {
    lines.push("    (none configured — delegate_task will refuse executor-unavailable until one is admitted)");
    return lines;
  }
  for (const row of rows) {
    const label = `${row.projection.name ?? row.agent.id} (${row.agent.id})`;
    if (row.admitted) {
      lines.push(`    ADMITTED  ${label} — ${row.agent.adapter}${row.installedVersion ? ` @ ${row.installedVersion}` : ""}`);
    } else {
      lines.push(`    REFUSED   ${label} — ${row.agent.adapter}: ${row.refused}`);
      lines.push(`              ${row.why}`);
    }
  }
  return lines;
}
