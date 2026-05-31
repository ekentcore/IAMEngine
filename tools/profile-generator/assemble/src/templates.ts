// Franchise-family templates: a partial profile overlaid on every practice in the family.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./profile.js";

type Json = Record<string, unknown>;

// objects merge recursively; arrays and scalars from `over` replace `base`.
export function deepMerge<T extends Json>(base: T, over: Json): T {
  const out: Json = Array.isArray(base) ? [...(base as unknown[])] as unknown as Json : { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = (out as Json)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Json, v as Json);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function applyTemplate(profile: Profile, family: string | null, templatesDir: string): Profile {
  if (!family) return profile;
  const path = join(templatesDir, `${family}.json`);
  if (!existsSync(path)) return profile;
  const tpl = JSON.parse(readFileSync(path, "utf8")) as Json;
  return deepMerge(profile as unknown as Json, tpl) as unknown as Profile;
}
