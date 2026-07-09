// Per-client M365 licensing rules: choose the onboarding license from intake facts (e.g. "needs a
// computer → E5, else E1"). Stored on the m365 system config as config.onboard.licenseRules and
// evaluated at PLAN time against the case context (the same grammar the v2.1 rules use), producing
// the concrete config.licenses the runner assigns. Pure — no I/O.
import { evalCondition, type PlanContext } from "../profiles/conditions";

export type LicenseRule = { when?: string; licenses: string[] };

// Normalize an unknown blob into well-formed rules (drops malformed entries). Used by the API
// validator and the evaluator so both agree on what a "rule" is.
export function normalizeLicenseRules(input: unknown): LicenseRule[] {
  if (!Array.isArray(input)) return [];
  const out: LicenseRule[] = [];
  for (const r of input) {
    if (!r || typeof r !== "object") continue;
    const o = r as { when?: unknown; licenses?: unknown };
    const licenses = Array.isArray(o.licenses)
      ? [...new Set(o.licenses.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))]
      : [];
    if (licenses.length === 0) continue; // a rule with no licenses can't do anything
    out.push({ when: typeof o.when === "string" ? o.when : "", licenses });
  }
  return out;
}

// First matching rule wins; a rule with an empty/absent `when` always matches (the default/fallback).
// Returns that rule's licenses, or null when there are no rules / none match.
export function evaluateLicenseRules(input: unknown, ctx: PlanContext): string[] | null {
  const rules = normalizeLicenseRules(input);
  for (const r of rules) {
    if (evalCondition(r.when, ctx)) return r.licenses;
  }
  return null;
}
