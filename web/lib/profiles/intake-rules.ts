// Per-contact intake rules (FR #0000019). When a configured ServiceNow contact submits an ONBOARD
// case, the plan skips named systems (e.g. active-directory + directory-sync) and forces an email
// domain (e.g. shawmutinfinite.com). Everyone else falls through to the client's normal plan.
//
// Stored on Client.intakeRules as { rules: IntakeRule[] }; evaluated here at plan/replan time.
// First matching rule wins. Match is on the requesting contact's sys_id only.

export type IntakeRuleContact = { sysId: string; name: string };
export type IntakeRule = {
  id: string;
  label: string;
  match: { contacts: IntakeRuleContact[] };
  effects: { skipSystems: string[]; forceDomain: string | null };
};
export type IntakeRulesDoc = { rules: IntakeRule[] };
export type MatchedIntakeRule = {
  id: string;
  label: string;
  skipSystems: ReadonlySet<string>;
  forceDomain: string | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Tolerant parse: any malformed input yields { rules: [] } (a client with no rules is the norm).
export function parseIntakeRules(value: unknown): IntakeRulesDoc {
  const raw = (value ?? null) as { rules?: unknown } | null;
  const list = raw && Array.isArray(raw.rules) ? raw.rules : [];
  const rules: IntakeRule[] = [];
  for (const r of list) {
    const o = (r ?? {}) as Record<string, unknown>;
    const match = (o.match ?? {}) as { contacts?: unknown };
    const effects = (o.effects ?? {}) as { skipSystems?: unknown; forceDomain?: unknown };
    const contacts = Array.isArray(match.contacts)
      ? match.contacts
          .map((c) => ({ sysId: str((c as Record<string, unknown>)?.sysId), name: str((c as Record<string, unknown>)?.name) }))
          .filter((c) => c.sysId !== "")
      : [];
    const skipSystems = Array.isArray(effects.skipSystems)
      ? effects.skipSystems.map(str).filter((s) => s !== "")
      : [];
    const forceDomain = str(effects.forceDomain) || null;
    rules.push({
      id: str(o.id) || `rule-${rules.length}`,
      label: str(o.label) || "Intake rule",
      match: { contacts },
      effects: { skipSystems, forceDomain },
    });
  }
  return { rules };
}

// First rule any of whose contacts' sysId equals the payload's requesting-contact sys_id
// (requestedByContactSysId primary, openedBySysId fallback). Null when none match.
export function matchIntakeRule(
  intakeRules: unknown,
  payload: Record<string, unknown>,
): MatchedIntakeRule | null {
  const keys = [payload.requestedByContactSysId, payload.openedBySysId]
    .map((v) => (typeof v === "string" ? v : ""))
    .filter((v) => v !== "");
  if (keys.length === 0) return null;
  const { rules } = parseIntakeRules(intakeRules);
  for (const rule of rules) {
    if (rule.match.contacts.some((c) => keys.includes(c.sysId))) {
      return {
        id: rule.id,
        label: rule.label,
        skipSystems: new Set(rule.effects.skipSystems),
        forceDomain: rule.effects.forceDomain,
      };
    }
  }
  return null;
}
