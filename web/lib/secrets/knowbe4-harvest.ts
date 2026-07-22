// Pure helpers for the KnowBe4 console browser-setup harvest: locating the harvested SCIM token in the
// runner's opaque result JSON, and stripping it back out once vaulted. Kept dependency-free so the
// security-sensitive find/scrub logic is unit-tested. Never logs values.

export type KnowBe4Harvested = { scimToken: string; baseUrl?: string };

// Deep-find the { scimToken, baseUrl? } object anywhere in the result (robust to how the runner nests
// the psm1's `Credentials` note-property). Returns null unless a non-empty scimToken is present.
export function findHarvested(v: unknown, depth = 0): KnowBe4Harvested | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  const o = v as Record<string, unknown>;
  const tok = o.scimToken ?? o.ScimToken ?? o.SCIMToken ?? o.token ?? o.Token;
  if (typeof tok === "string" && tok.trim()) {
    const base = o.baseUrl ?? o.BaseUrl ?? o.baseURL;
    return { scimToken: tok.trim(), baseUrl: typeof base === "string" && base.trim() ? base.trim() : undefined };
  }
  for (const val of Object.values(o)) {
    const hit = findHarvested(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Return a deep copy of `result` with the harvested-token keys removed, marked scrubbed — what we
// overwrite the persisted job result with after vaulting.
export function scrubHarvested(result: unknown): unknown {
  const stripped = JSON.parse(JSON.stringify(result ?? {}), (k, val) =>
    k === "Credentials" || k === "scimToken" || k === "ScimToken" || k === "SCIMToken" ? undefined : val,
  );
  return { ...stripped, _harvestScrubbed: true };
}
