// core/policy.ts — decide(resolvedAct, root) -> allow | confirm | refuse(ruleId, why).
// First matching rule wins; tier 0 refuses; tier 2 asks.
//
// CHANGED for E1-M0: the decision takes the project root, because the table's first row is the
// containment comparison and that comparison needs the boundary it is comparing against.

import { RULES, ENFORCEABLE, type Act, type Rule, type RuleContext } from "./tier-table.ts";

export type Decision =
  | { decision: "allow"; rule: string }
  | { decision: "confirm"; rule: string; why: string }
  | { decision: "refuse"; rule: string; why: string };

export function decide(act: Act, ctx: RuleContext): Decision {
  for (const rule of RULES) {
    if (!rule.matches(act, ctx)) continue;
    if (rule.tier === 0) {
      return { decision: "refuse", rule: rule.id, why: rule.why };
    }
    if (rule.tier === 2) {
      return { decision: "confirm", rule: rule.id, why: rule.why };
    }
    return { decision: "allow", rule: rule.id };
  }
  // No rule matched: the default is refuse (fail closed).
  return { decision: "refuse", rule: "no-match", why: "no enforcement rule matched this act" };
}
