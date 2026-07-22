// Pure helpers for the Zoom console browser-setup harvest: locating the harvested Server-to-Server
// OAuth credential in the runner's opaque result JSON, and stripping it back out once vaulted. Kept
// dependency-free so the security-sensitive find/scrub logic is unit-tested. Never logs values.

export type ZoomHarvested = { accountId: string; clientId: string; clientSecret: string };

// Deep-find the { accountId, clientId, clientSecret } object anywhere in the result (robust to how the
// runner nests the psm1's `Credentials` note-property). Returns null unless all three are present.
export function findHarvested(v: unknown, depth = 0): ZoomHarvested | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  const o = v as Record<string, unknown>;
  const acc = o.accountId ?? o.AccountId ?? o.AccountID;
  const id = o.clientId ?? o.ClientID ?? o.clientID;
  const sec = o.clientSecret ?? o.ClientSecret;
  if (typeof acc === "string" && acc.trim() && typeof id === "string" && id.trim() && typeof sec === "string" && sec.trim()) {
    return { accountId: acc.trim(), clientId: id.trim(), clientSecret: sec.trim() };
  }
  for (const val of Object.values(o)) {
    const hit = findHarvested(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Return a deep copy of `result` with the harvested-credential keys removed, marked scrubbed — what we
// overwrite the persisted job result with after vaulting.
export function scrubHarvested(result: unknown): unknown {
  const stripped = JSON.parse(JSON.stringify(result ?? {}), (k, val) =>
    k === "Credentials" || k === "clientSecret" || k === "ClientSecret" ? undefined : val,
  );
  return { ...stripped, _harvestScrubbed: true };
}
