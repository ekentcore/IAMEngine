// v2.1 enrichment: extract the role/group/location signal the v2.0 heuristic dropped.
// The KB runbooks DO carry "Member Of:" group lists, an attribute/Organization-tab map, and
// (for some clients) role- and location-conditional rules — the v2.0 generator only kept a
// single OU. This pass uses the LLM to pull that signal into the v2.1 blocks (globals/personas/
// locations). Pure coerce + apply here are unit-tested; the live LLM call lives in the script.
//
// Mapping into a profile:
//   identityGroups + attributes  -> globals[identityKey].{groups,attributes}   (every user)
//   personas[]                   -> top-level personas{} (fragment under identityKey)
//   locations[]                  -> top-level locations{}
//   usernamePattern              -> identity.usernamePatterns (hoisted, deduped)
// Any populated block bumps schemaVersion to "2.1".

export const V21_SYSTEM_PROMPT = `You are analyzing ONE client's Coretelligent IT onboarding runbook to extract directory
provisioning detail that a generic heuristic misses. Return STRICT JSON only — no prose.

Extract ONLY what the runbook explicitly states. Do not invent groups, attributes, roles, or
locations. Empty arrays/objects are correct when the runbook says nothing.

Attribute VALUES must be {token} templates when they come from the new-hire's intake data, using
these tokens: {first} {last} {firstInitial} {title} {department} {manager} {office} {location.city}
{location.state}. Use a literal string only for a fixed value (e.g. company name). Use the EXACT
directory attribute name as the key (title, department, company, manager, physicalDeliveryOfficeName,
extensionAttribute1, ipPhone, c, co, countryCode, proxyAddresses, employeeType).

JSON shape:
{
  "identityGroups": ["<security/distribution/M365 group EVERY new user is added to>"],
  "attributes": { "<dirAttr>": "<{token} template or literal>" },
  "usernamePattern": "<e.g. {first}.{last} or {firstInitial}{last}, else null>",
  "personas": [
    { "name": "<role/department>", "titles": ["<job title>"], "groups": ["<extra groups for THIS role only>"], "ou": "<OU for this role, else null>" }
  ],
  "locations": [
    { "name": "<office/site>", "city": "<city>", "state": "<state>", "timezone": "<Windows tz id>", "country": { "short": "<US/IN/…>" } }
  ]
}
Only include a persona when the runbook gives a role/department DIFFERENT config (groups/OU/title).
If everyone gets the same thing, leave personas empty.`;

export type V21Persona = { name: string; titles: string[]; groups: string[]; ou: string | null };
export type V21Location = {
  name: string; city?: string; state?: string; timezone?: string;
  country?: { short?: string; name?: string; code?: string | number };
};
export type V21Enrichment = {
  identityGroups: string[];
  attributes: Record<string, string | number | boolean>;
  usernamePattern: string | null;
  personas: V21Persona[];
  locations: V21Location[];
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()) : [];

// A value the LLM echoed straight from a "fill this in" placeholder (xxx-xxx-xxxx, X, N/A, TBD),
// not real config. Tokens like {title} and real literals are NOT placeholders.
const isPlaceholder = (s: string): boolean =>
  /^[x\s.\-_()]+$/i.test(s) || /^(n\/?a|tbd|todo|none|null|xxx+)$/i.test(s.trim());
// A name the LLM left as an unresolved template (e.g. "{office}") — useless as a map key.
const isTokenName = (s: string): boolean => /\{[^}]+\}/.test(s);

function scalarMap(v: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (!k.trim()) continue;
    if (typeof val === "string" && val.trim() !== "" && !isPlaceholder(val)) out[k] = val.trim();
    else if (typeof val === "number" || typeof val === "boolean") out[k] = val;
    // object/array values and placeholder junk are dropped (conditional-array form is hand-authored)
  }
  return out;
}

export function coerceV21Enrichment(raw: unknown): V21Enrichment | null {
  if (!isObj(raw)) return null;

  const identityGroups = strList(raw.identityGroups);
  const attributes = scalarMap(raw.attributes);
  const up = typeof raw.usernamePattern === "string" && raw.usernamePattern.includes("{") ? raw.usernamePattern.trim() : null;

  const personas: V21Persona[] = (Array.isArray(raw.personas) ? raw.personas : [])
    .filter(isObj)
    .map((p) => ({
      name: typeof p.name === "string" ? p.name.trim() : "",
      titles: strList(p.titles),
      groups: strList(p.groups),
      ou: typeof p.ou === "string" && p.ou.trim() ? p.ou.trim() : null,
    }))
    .filter((p) => p.name && !isTokenName(p.name) && (p.groups.length || p.ou || p.titles.length));

  const locations: V21Location[] = (Array.isArray(raw.locations) ? raw.locations : [])
    .filter(isObj)
    .map((l) => {
      const loc: V21Location = { name: typeof l.name === "string" ? l.name.trim() : "" };
      for (const k of ["city", "state", "timezone"] as const) if (typeof l[k] === "string" && (l[k] as string).trim()) loc[k] = (l[k] as string).trim();
      if (isObj(l.country)) {
        const c: V21Location["country"] = {};
        if (typeof l.country.short === "string") c.short = l.country.short.trim();
        if (typeof l.country.name === "string") c.name = l.country.name.trim();
        if (typeof l.country.code === "string" || typeof l.country.code === "number") c.code = l.country.code;
        if (Object.keys(c).length) loc.country = c;
      }
      return loc;
    })
    .filter((l) => l.name && !isTokenName(l.name));

  // Nothing usable → null, so the caller leaves the profile as valid v2.0.
  if (!identityGroups.length && !Object.keys(attributes).length && !up && !personas.length && !locations.length) return null;
  return { identityGroups, attributes, usernamePattern: up, personas, locations };
}

// The system whose config the directory groups/attributes belong to: AD if on-prem, else the
// cloud identity system (entra/m365). null when the client has no directory system at all.
export function identitySystemKey(systems: Array<{ key?: unknown }>): string | null {
  const keys = new Set(systems.map((s) => String(s.key)));
  for (const k of ["active-directory", "entra", "m365"]) if (keys.has(k)) return k;
  return null;
}

type ProfileLike = {
  schemaVersion: string;
  identity: Record<string, unknown> & { usernamePatterns?: unknown };
  systems: Array<{ key?: unknown }>;
  globals?: Record<string, Record<string, unknown>>;
  personas?: Record<string, unknown>;
  locations?: Record<string, unknown>;
};

export function applyV21Enrichment(profile: ProfileLike, e: V21Enrichment): void {
  const idKey = identitySystemKey(profile.systems);
  let touched = false;

  // every-user groups + attributes -> globals[idKey]
  if (idKey && (e.identityGroups.length || Object.keys(e.attributes).length)) {
    profile.globals ??= {};
    const g = (profile.globals[idKey] ??= {});
    if (e.identityGroups.length) g.groups = e.identityGroups;
    if (Object.keys(e.attributes).length) g.attributes = e.attributes;
    touched = true;
  }

  // username pattern -> hoist in front of the heuristic defaults (deduped)
  if (e.usernamePattern) {
    const cur = Array.isArray(profile.identity.usernamePatterns) ? (profile.identity.usernamePatterns as string[]) : [];
    profile.identity.usernamePatterns = [e.usernamePattern, ...cur.filter((p) => p !== e.usernamePattern)];
    touched = true;
  }

  // personas -> top-level, each contributing a fragment under the identity system key
  if (e.personas.length) {
    profile.personas ??= {};
    for (const p of e.personas) {
      const frag: Record<string, unknown> = {};
      if (p.groups.length) frag.groups = p.groups;
      if (p.ou) frag.ou = p.ou;
      // a persona must contribute to at least one system; fall back to a known key if none detected
      const key = idKey ?? "active-directory";
      profile.personas[p.name] = { ...(p.titles.length ? { titles: p.titles } : {}), systems: { [key]: frag } };
    }
    touched = true;
  }

  // locations -> top-level, keyed by name
  if (e.locations.length) {
    profile.locations ??= {};
    for (const l of e.locations) {
      const { name, ...rest } = l;
      profile.locations[name] = rest;
    }
    touched = true;
  }

  if (touched) profile.schemaVersion = "2.1";
}
