// Three independent measurements for one suite, never a retry/waiver of the original gate verdict.
// A missing arm is UNKNOWN, not a green run. Disagreement names the suite as the defect.
export const CONDITION_NAMES = Object.freeze(["standalone", "heavy_slot", "shard_concurrency"]);
export const CONDITION_STATUSES = Object.freeze(["passed", "failed", "skipped", "timeout", "unknown"]);

export function classifySuiteConditions(suite, conditions) {
  const missing = CONDITION_NAMES.filter((name) => !["passed", "failed"].includes(conditions?.[name]?.status));
  if (missing.length) return { verdict: "unknown", reason: `${suite}: incomplete three-condition evidence (${missing.join(", ")}) — suite needs diagnosis` };
  const outcomes = CONDITION_NAMES.map((name) => `${name}=${conditions[name].status}`);
  if (new Set(CONDITION_NAMES.map((name) => conditions[name].status)).size !== 1) {
    return { verdict: "suite-defect", reason: `${suite}: conditions disagree (${outcomes.join(", ")}) — the suite is the defect` };
  }
  if (conditions.standalone.status !== "passed") {
    return { verdict: "suite-defect", reason: `${suite}: all three conditions ${conditions.standalone.status} — the suite is the defect` };
  }
  return { verdict: "passed", reason: `${suite}: green standalone, with the heavy slot held, and at shard concurrency` };
}
