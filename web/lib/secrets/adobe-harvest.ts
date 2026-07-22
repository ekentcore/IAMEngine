// Pure helpers for the Adobe Developer Console browser harvest: locating the harvested OAuth
// Server-to-Server credential ({ clientId, clientSecret, orgId }) in the runner's opaque result JSON,
// and stripping the secret back out once vaulted. Dependency-free so the security-sensitive find/scrub
// logic is unit-tested. Never logs values.

export type AdobeHarvested = { clientId: string; clientSecret: string; orgId?: string };

// Deep-find the { clientId, clientSecret, orgId? } object anywhere in the result (robust to how the
// runner nests the psm1's `Credentials` note-property). orgId is optional (harvested if present).
export function findAdobeHarvested(v: unknown, depth = 0): AdobeHarvested | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  const o = v as Record<string, unknown>;
  const id = o.clientId ?? o.ClientID ?? o.clientID;
  const sec = o.clientSecret ?? o.ClientSecret;
  if (typeof id === "string" && id.trim() && typeof sec === "string" && sec.trim()) {
    const org = o.orgId ?? o.OrgId ?? o.orgID ?? o.organizationId;
    return { clientId: id.trim(), clientSecret: sec.trim(), ...(typeof org === "string" && org.trim() ? { orgId: org.trim() } : {}) };
  }
  for (const val of Object.values(o)) {
    const hit = findAdobeHarvested(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Deep copy of `result` with the harvested secret removed, marked scrubbed — overwrites the persisted
// job result after vaulting. (orgId + clientId are identifiers, not secrets, but the whole Credentials
// note-property is dropped for good measure.)
export function scrubAdobeHarvested(result: unknown): unknown {
  const stripped = JSON.parse(JSON.stringify(result ?? {}), (k, val) =>
    k === "Credentials" || k === "clientSecret" || k === "ClientSecret" ? undefined : val,
  );
  return { ...stripped, _harvestScrubbed: true };
}
