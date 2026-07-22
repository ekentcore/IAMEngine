// Pure helpers for the Spanning console browser harvest: locating the harvested API token in the
// runner's opaque result JSON, and stripping it back out once vaulted. Dependency-free so the
// security-sensitive find/scrub logic is unit-tested. Never logs values.

// `username` is the API username the console returned alongside the token (its msUserPrincipalName —
// the login email); present when the runner harvested it, absent otherwise. Non-secret (it's the admin
// email the operator already typed), so it is NOT scrubbed — only the token is.
export type HarvestedToken = { apiToken: string; username?: string };

// Deep-find the harvested API token anywhere in the result (robust to how the runner nests the psm1's
// `Credentials` note-property). Accepts the token under a few key spellings, and picks up a sibling
// username (the console's msUserPrincipalName) at the same object when present. Returns null if absent.
export function findSpanningToken(v: unknown, depth = 0): HarvestedToken | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  const o = v as Record<string, unknown>;
  const tok = o.apiToken ?? o.ApiToken ?? o.apiKey ?? o.ApiKey ?? o.token ?? o.Token;
  if (typeof tok === "string" && tok.trim()) {
    const un = o.username ?? o.Username ?? o.msUserPrincipalName ?? o.MsUserPrincipalName ?? o.userName ?? o.UserName;
    return typeof un === "string" && un.trim()
      ? { apiToken: tok.trim(), username: un.trim() }
      : { apiToken: tok.trim() };
  }
  for (const val of Object.values(o)) {
    const hit = findSpanningToken(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Return a deep copy of `result` with the harvested-token keys removed, marked scrubbed — what we
// overwrite the persisted job result with after vaulting.
export function scrubSpanningToken(result: unknown): unknown {
  const stripped = JSON.parse(JSON.stringify(result ?? {}), (k, val) =>
    k === "Credentials" || k === "apiToken" || k === "ApiToken" || k === "apiKey" || k === "ApiKey" || k === "token" || k === "Token"
      ? undefined
      : val,
  );
  return { ...stripped, _harvestScrubbed: true };
}
