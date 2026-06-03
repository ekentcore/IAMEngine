// Resolve v2.1 config fragments (globals + selected persona + the system's own config) into ONE
// flat, concrete per-system config the runner can execute — all conditions/templates resolved at
// plan time. Precedence low→high: globals, persona, own. `groups` UNION across layers; scalars and
// nested objects deep-merge (own wins); `attributes`/`ou` resolve their conditional forms. Pure.
import { evalCondition, interpolate, type PlanContext } from "./conditions";

type Fragment = Record<string, unknown>;

// groupList item: a plain (templated) name, or { groups, when }.
export function resolveGroups(list: unknown, ctx: PlanContext): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") out.push(interpolate(item, ctx));
    else if (item && typeof item === "object") {
      const b = item as { groups?: unknown; when?: string };
      if (Array.isArray(b.groups) && evalCondition(b.when, ctx)) {
        for (const g of b.groups) if (typeof g === "string") out.push(interpolate(g, ctx));
      }
    }
  }
  // dedupe, case-insensitive, keeping first occurrence
  const seen = new Set<string>();
  return out.filter((g) => { const k = g.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Interpolate a template; return undefined if it still has an unresolved {token} (the value's data
// wasn't in context — e.g. {location.city} for a location with no city), so the attribute is OMITTED
// rather than written with a literal token. Matches the script (null attrs are skipped).
function resolvedTemplate(template: string, ctx: PlanContext): string | undefined {
  const out = interpolate(template, ctx);
  return /\{[a-zA-Z]/.test(out) ? undefined : out;
}

// attributeMap value: a template scalar, or a conditional list (first matching `when` wins).
export function resolveAttributes(map: unknown, ctx: PlanContext): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!map || typeof map !== "object") return out;
  for (const [attr, value] of Object.entries(map as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const hit = (value as Array<{ value: unknown; when?: string }>).find((e) => e && typeof e === "object" && evalCondition(e.when, ctx));
      if (hit === undefined) continue;
      if (typeof hit.value === "string") { const r = resolvedTemplate(hit.value, ctx); if (r !== undefined) out[attr] = r; }
      else out[attr] = hit.value as string | number | boolean;
    } else if (typeof value === "string") {
      const r = resolvedTemplate(value, ctx);
      if (r !== undefined) out[attr] = r;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[attr] = value;
    }
  }
  return out;
}

// ouSpec: a templated string, or an array of { path, when } resolved to the first match.
export function resolveOu(spec: unknown, ctx: PlanContext): string | undefined {
  if (typeof spec === "string") return interpolate(spec, ctx);
  if (Array.isArray(spec)) {
    const hit = (spec as Array<{ path: string; when?: string }>).find((e) => e && typeof e === "object" && evalCondition(e.when, ctx));
    return hit ? interpolate(hit.path, ctx) : undefined;
  }
  return undefined;
}

// Deep-merge plain objects (later wins); arrays/scalars from the overlay replace the base.
function deepMerge(base: Fragment, overlay: Fragment): Fragment {
  const out: Fragment = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const b = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = deepMerge(b as Fragment, v as Fragment);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Interpolate every string value in a nested structure (for arbitrary keys like homeDrive.unc).
function interpolateDeep(value: unknown, ctx: PlanContext): unknown {
  if (typeof value === "string") return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateDeep(v, ctx);
    return out;
  }
  return value;
}

// The keystone: flatten the layers for one system into the runner's concrete config.
export function resolveSystemConfig(
  systemKey: string,
  layers: { globals?: Fragment | null; persona?: Fragment | null; own?: Fragment | null },
  ctx: PlanContext
): Record<string, unknown> {
  const fragments = [layers.globals, layers.persona, layers.own].filter((f): f is Fragment => !!f);

  // groups: union across every layer.
  const groups = (() => {
    const seen = new Set<string>();
    const all: string[] = [];
    for (const f of fragments) for (const g of resolveGroups(f.groups, ctx)) { const k = g.toLowerCase(); if (!seen.has(k)) { seen.add(k); all.push(g); } }
    return all;
  })();

  // everything else (scalars + nested objects, incl. attributes/ou) deep-merges, own last.
  let merged: Fragment = {};
  for (const f of fragments) {
    const { groups: _g, ...rest } = f;
    merged = deepMerge(merged, rest);
  }

  const attributes = "attributes" in merged ? resolveAttributes(merged.attributes, ctx) : undefined;
  const ou = "ou" in merged ? resolveOu(merged.ou, ctx) : undefined;
  delete merged.attributes;
  delete merged.ou;

  const resolved = interpolateDeep(merged, ctx) as Record<string, unknown>;
  if (groups.length) resolved.groups = groups;
  if (attributes && Object.keys(attributes).length) resolved.attributes = attributes;
  if (ou !== undefined) resolved.ou = ou;
  void systemKey; // reserved: per-system validation hook
  return resolved;
}
