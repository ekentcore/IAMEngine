// Shapes + validation for the v2.1 personas/globals rules edited by the no-code editor. The editor
// PUTs these back as the Client.personas / Client.globals JSON columns. Validation is conservative:
// it confirms the structure and that every condition (`when` / persona `match`) parses against the
// real grammar, so a saved rule can't silently never-fire. Pure, used by the API route + tests.
import { validateCondition } from "../profiles/condition-builder";

export type GroupEntry = string | { groups: string[]; when?: string };
export type OuEntry = string | Array<{ path: string; when?: string }>;
export type AttrValue = string | number | boolean | Array<{ value: string | number | boolean; when?: string }>;
export type Fragment = { groups?: GroupEntry[]; ou?: OuEntry; attributes?: Record<string, AttrValue>; licenses?: string[]; [k: string]: unknown };
export type Persona = { label?: string; titles?: string[]; match?: string; systems?: Record<string, Fragment> };
export type RulesPayload = { personas?: Record<string, Persona>; globals?: Record<string, Fragment> };

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);

// Walk a fragment and yield every condition string in it (group bundles, OU entries, conditional
// attribute values), tagged with a path for error messages.
function* fragmentConditions(where: string, frag: unknown): Generator<{ at: string; expr: string }> {
  if (!isObj(frag)) return;
  if (Array.isArray(frag.groups)) {
    for (const g of frag.groups) if (isObj(g) && typeof g.when === "string") yield { at: `${where} group rule`, expr: g.when };
  }
  if (Array.isArray(frag.ou)) {
    for (const o of frag.ou) if (isObj(o) && typeof o.when === "string") yield { at: `${where} OU rule`, expr: o.when };
  }
  if (isObj(frag.attributes)) {
    for (const [attr, val] of Object.entries(frag.attributes)) {
      if (Array.isArray(val)) for (const v of val) if (isObj(v) && typeof v.when === "string") yield { at: `${where} attribute "${attr}"`, expr: v.when };
    }
  }
}

// Every condition string in the payload (for validation + for tests).
export function collectConditions(payload: RulesPayload): { at: string; expr: string }[] {
  const out: { at: string; expr: string }[] = [];
  for (const [sys, frag] of Object.entries(payload.globals ?? {})) out.push(...fragmentConditions(`Everyone · ${sys}`, frag));
  for (const [name, persona] of Object.entries(payload.personas ?? {})) {
    if (persona && typeof persona.match === "string" && persona.match.trim()) out.push({ at: `Persona "${name}" match`, expr: persona.match });
    for (const [sys, frag] of Object.entries(persona?.systems ?? {})) out.push(...fragmentConditions(`Persona "${name}" · ${sys}`, frag));
  }
  return out;
}

// Validate structure + all conditions. Returns the first problem found, or ok.
// Defense-in-depth bounds: the columns are operator config, but the route is reachable without
// auth, so cap size/counts to avoid storage bloat / slow plan-time merges from a hostile payload.
const MAX_BYTES = 256_000;
const MAX_PERSONAS = 200;

export function validateRules(payload: unknown): { ok: true; value: RulesPayload } | { ok: false; error: string } {
  if (!isObj(payload)) return { ok: false, error: "rules payload must be an object" };
  if (JSON.stringify(payload).length > MAX_BYTES) return { ok: false, error: "rules payload is too large" };
  if (payload.globals !== undefined && !isObj(payload.globals)) return { ok: false, error: "globals must be an object keyed by system" };
  if (payload.personas !== undefined && !isObj(payload.personas)) return { ok: false, error: "personas must be an object keyed by name" };
  if (isObj(payload.personas) && Object.keys(payload.personas).length > MAX_PERSONAS) return { ok: false, error: `too many personas (max ${MAX_PERSONAS})` };
  const value = payload as RulesPayload;
  for (const { at, expr } of collectConditions(value)) {
    const v = validateCondition(expr);
    if (!v.ok) return { ok: false, error: `${at}: ${v.error}` };
  }
  return { ok: true, value };
}
