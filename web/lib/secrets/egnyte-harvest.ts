// Pure helpers for the Egnyte console browser-setup harvest: locating the harvested { domain, token }
// in the runner's opaque result JSON, and stripping it back out once vaulted. Kept dependency-free so
// the security-sensitive find/scrub logic is unit-tested. Never logs values.

export type EgnyteHarvested = { domain: string; token: string };

// Deep-find the { domain, token } object anywhere in the result (robust to how the runner nests the
// psm1's `Credentials` note-property). Returns null unless a plausibly-long token is present; the
// domain is echoed back by the flow from its input, so it may be empty here and is backfilled by the
// caller from the known client Egnyte domain.
export function findHarvested(v: unknown, depth = 0): EgnyteHarvested | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  const o = v as Record<string, unknown>;
  const token = o.token ?? o.Token ?? o.apiToken ?? o.ApiToken ?? o.apiKey ?? o.ApiKey;
  if (typeof token === "string" && token.trim().length > 8) {
    const domain = o.domain ?? o.Domain ?? o.egnyteDomain ?? o.EgnyteDomain;
    return { domain: typeof domain === "string" ? domain.trim() : "", token: token.trim() };
  }
  for (const val of Object.values(o)) {
    const hit = findHarvested(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Return a deep copy of `result` with the harvested token removed, marked scrubbed — what we overwrite
// the persisted job result with after vaulting.
export function scrubHarvested(result: unknown): unknown {
  const stripped = JSON.parse(JSON.stringify(result ?? {}), (k, val) =>
    k === "Credentials" || k === "token" || k === "Token" || k === "apiToken" || k === "ApiToken" || k === "apiKey" || k === "ApiKey" ? undefined : val,
  );
  return { ...stripped, _harvestScrubbed: true };
}
