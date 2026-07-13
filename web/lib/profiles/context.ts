// Build the plan-time context the v2.1 engine resolves against: map the (derived) onboard payload
// to the grammar's tokens, enrich it with the matched location (hoisting country to a top-level
// sibling, per the grammar's `country.*`), and select the persona. Pure — no I/O.
import { evalCondition, type PlanContext } from "./conditions";

type PersonaDef = { match?: string; titles?: string[]; systems?: Record<string, unknown>; offboardSystems?: Record<string, unknown> };
type Personas = Record<string, PersonaDef>;
// A location can also carry AD/Entra TARGETS applied when a hire matches it (e.g. Boston → group
// FalconBOS + the floor-printer groups). All optional and per-client: groups, an OU placement, address
// attributes, an AD site. Resolved in plan-resolve, not here.
export type LocationDef = {
  timezone?: string; country?: Record<string, unknown>; city?: string; state?: string; zip?: string; address?: string;
  groups?: string[]; ou?: string; attributes?: Record<string, unknown>; site?: string;
};
type Locations = Record<string, LocationDef>;

export type SelectedPersona = { name: string; def: PersonaDef };

// Pick the persona: by explicit role name (case-insensitive), else the first whose `match` is true.
export function selectPersona(roleName: string | null | undefined, personas: Personas | null | undefined, ctx: PlanContext): SelectedPersona | null {
  if (!personas) return null;
  if (roleName) {
    const key = Object.keys(personas).find((k) => k.toLowerCase() === roleName.trim().toLowerCase());
    if (key) return { name: key, def: personas[key] };
  }
  for (const [name, def] of Object.entries(personas)) {
    if (def.match && evalCondition(def.match, ctx)) return { name, def };
  }
  return null;
}

// Match the intake's office location to a profile location key: exact (case-insensitive) first,
// else a key that appears as a WHOLE WORD in the office string ("Needham, MA office" -> "MA"). The
// word boundary matters: a plain substring would match "MA"/"CA" inside "Camden"/"Cambridge".
function matchLocation(office: string | undefined, locations: Locations | null | undefined): { key: string; data: LocationDef } | null {
  if (!locations || !office) return null;
  const o = office.trim().toLowerCase();
  const exact = Object.keys(locations).find((k) => k.toLowerCase() === o);
  if (exact) return { key: exact, data: locations[exact] };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contained = Object.keys(locations).find((k) => new RegExp(`\\b${escape(k.toLowerCase())}\\b`).test(o));
  if (contained) return { key: contained, data: locations[contained] };
  return null;
}

export function buildPlanContext(
  payload: Record<string, unknown>,
  profile: { personas?: Personas | null; locations?: Locations | null }
): { context: PlanContext; persona: SelectedPersona | null; location: LocationDef | null } {
  const s = (k: string): string | undefined => (payload[k] == null || payload[k] === "" ? undefined : String(payload[k]));
  // The intake emits `roles` (a list); fall back to `role`/`department` (Coretelligent uses dept).
  const roles = payload.roles;
  const roleName = s("role") ?? (Array.isArray(roles) && roles.length ? String(roles[0]) : undefined) ?? s("department") ?? null;

  const loc = matchLocation(s("officeLocation") ?? s("location"), profile.locations);
  const ld = loc?.data ?? {};

  const context: PlanContext = {
    ...payload, // pass through intake booleans (avd, perimeter, …) and any raw fields
    first: s("firstName"),
    last: s("lastName"),
    title: s("jobTitle") ?? s("title"),
    employmentType: s("employmentType"),
    startDate: s("startDate"),
    mobile: s("mobilePhone"),
    manager: s("managerName") ?? s("manager"),
    extension: s("extension"),
    did: s("did") ?? s("officePhone"),
    username: s("samAccountName"),
    upn: s("userPrincipalName"),
    domain: s("primaryDomain"),
    role: roleName ? { name: roleName } : undefined,
    location: loc || s("officeLocation") || s("location")
      ? { name: loc?.key ?? s("officeLocation") ?? s("location"), timezone: ld.timezone, city: ld.city, state: ld.state, zip: ld.zip, address: ld.address }
      : undefined,
    country: (ld.country as Record<string, unknown> | undefined) ?? undefined,
  };

  const persona = selectPersona(roleName, profile.personas, context);
  // canonical-case the role to the matched persona key
  if (persona && context.role && typeof context.role === "object") (context.role as { name: string }).name = persona.name;

  return { context, persona, location: loc?.data ?? null };
}
