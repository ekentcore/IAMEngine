// v2.1 enrichment for the assemble stage: pull the role/group/attribute/location signal the
// deterministic IR build doesn't carry, and fold it into the v2.1 profile blocks. The pure
// coerce + apply are unit-tested; the live LLM call uses ./llm. Mirrors web/lib/generator/
// enrich-v21.ts (kept in sync — the legacy generator uses that copy).
import { azureChatJson, type AzureConfig } from "./llm.js";
import type { IR } from "./ir.js";
import type { Profile } from "./profile.js";

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

export interface V21Persona { name: string; titles: string[]; groups: string[]; ou: string | null }
export interface V21Location {
  name: string; city?: string; state?: string; timezone?: string;
  country?: { short?: string; name?: string; code?: string | number };
}
export interface V21Enrichment {
  identityGroups: string[];
  attributes: Record<string, string | number | boolean>;
  usernamePattern: string | null;
  personas: V21Persona[];
  locations: V21Location[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()) : [];
const isPlaceholder = (s: string): boolean =>
  /^[x\s.\-_()]+$/i.test(s) || /^(n\/?a|tbd|todo|none|null|xxx+)$/i.test(s.trim());
const isTokenName = (s: string): boolean => /\{[^}]+\}/.test(s);

function scalarMap(v: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (!k.trim()) continue;
    if (typeof val === "string" && val.trim() !== "" && !isPlaceholder(val)) out[k] = val.trim();
    else if (typeof val === "number" || typeof val === "boolean") out[k] = val;
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

  if (!identityGroups.length && !Object.keys(attributes).length && !up && !personas.length && !locations.length) return null;
  return { identityGroups, attributes, usernamePattern: up, personas, locations };
}

export function identitySystemKey(systems: Array<{ key?: unknown }>): string | null {
  const keys = new Set(systems.map((s) => String(s.key)));
  for (const k of ["active-directory", "entra", "m365"]) if (keys.has(k)) return k;
  return null;
}

export function applyV21Enrichment(profile: Profile, e: V21Enrichment): void {
  const p = profile as Profile & {
    globals?: Record<string, Record<string, unknown>>;
    personas?: Record<string, unknown>;
    locations?: Record<string, unknown>;
  };
  const idKey = identitySystemKey(profile.systems);
  let touched = false;

  if (idKey && (e.identityGroups.length || Object.keys(e.attributes).length)) {
    p.globals ??= {};
    const g = (p.globals[idKey] ??= {});
    if (e.identityGroups.length) g.groups = e.identityGroups;
    if (Object.keys(e.attributes).length) g.attributes = e.attributes;
    touched = true;
  }

  if (e.usernamePattern) {
    const cur = Array.isArray(profile.identity.usernamePatterns) ? profile.identity.usernamePatterns : [];
    profile.identity.usernamePatterns = [e.usernamePattern, ...cur.filter((x) => x !== e.usernamePattern)];
    touched = true;
  }

  if (e.personas.length) {
    p.personas ??= {};
    for (const persona of e.personas) {
      const frag: Record<string, unknown> = {};
      if (persona.groups.length) frag.groups = persona.groups;
      if (persona.ou) frag.ou = persona.ou;
      const key = idKey ?? "active-directory";
      p.personas[persona.name] = { ...(persona.titles.length ? { titles: persona.titles } : {}), systems: { [key]: frag } };
    }
    touched = true;
  }

  if (e.locations.length) {
    p.locations ??= {};
    for (const l of e.locations) {
      const { name, ...rest } = l;
      p.locations[name] = rest;
    }
    touched = true;
  }

  if (touched) profile.schemaVersion = "2.1";
}

// Reconstruct runbook text from the IR (section headers + steps, per action) to feed the LLM.
export function irRunbookText(ir: IR): string {
  const lines = (action: "onboarding" | "offboarding"): string => {
    const parts: string[] = [];
    for (const d of ir.detected.filter((x) => x.action === action)) {
      parts.push(`# ${d.section}`);
      for (const s of d.steps ?? []) parts.push(s);
    }
    for (const u of ir.unmodeled.filter((x) => x.action === action)) {
      parts.push(`# ${u.section}`);
      for (const s of u.steps ?? []) parts.push(s);
    }
    return parts.join("\n");
  };
  return `Client: ${ir.client.leaf}
=== ONBOARDING RUNBOOK ===
${lines("onboarding") || "(none)"}
=== OFFBOARDING RUNBOOK ===
${lines("offboarding") || "(none)"}`;
}

export async function enrichV21(cfg: AzureConfig, ir: IR): Promise<V21Enrichment | null> {
  const raw = await azureChatJson(cfg, V21_SYSTEM_PROMPT, irRunbookText(ir), 1500);
  return raw ? coerceV21Enrichment(raw) : null;
}
