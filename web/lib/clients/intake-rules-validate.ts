import { parseIntakeRules, type IntakeRulesDoc } from "../profiles/intake-rules";

// A plausible DNS domain (mirrors the check used for email domains): labels + a TLD.
function plausibleDomain(v: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(v);
}

export function validateIntakeRulesBody(
  body: unknown,
): { ok: true; value: IntakeRulesDoc } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { rules?: unknown }).rules)) {
    return { ok: false, error: "expected { rules: [] }" };
  }
  const doc = parseIntakeRules(body);
  for (const r of doc.rules) {
    if (r.match.contacts.length === 0) return { ok: false, error: `rule "${r.label}" has no contacts` };
    if (r.effects.forceDomain !== null && !plausibleDomain(r.effects.forceDomain)) {
      return { ok: false, error: `rule "${r.label}" has an invalid domain "${r.effects.forceDomain}"` };
    }
  }
  return { ok: true, value: doc };
}
