// Pure helpers for the Slack console browser-setup harvest: locating the harvested SCIM token in the
// runner's opaque result JSON, and stripping it back out once vaulted. Kept dependency-free so the
// security-sensitive find/scrub logic is unit-tested. Never logs values.
//
// Unlike the multi-field vendors (Zoom/Adobe), the `slack` secret is a SINGLE bearer token (SCIM,
// admin scope) — so the harvest is one string. NOTE: Slack rarely exposes a SCIM token as a readable
// console field (it comes from an app/OAuth with the admin scope), so the browser flow is best-effort
// and often returns nothing — the guided PASTE path stays the reliable way to vault this credential.

export type SlackHarvested = { token: string };

// Deep-find a harvested SCIM token anywhere in the result (robust to how the runner nests the psm1's
// `Credentials` note-property). Accepts the common key spellings; returns null unless a non-empty
// token is present.
export function findHarvested(v: unknown, depth = 0): SlackHarvested | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  const o = v as Record<string, unknown>;
  const tok = o.token ?? o.Token ?? o.scimToken ?? o.SCIMToken ?? o.apiToken ?? o.ApiToken;
  if (typeof tok === "string" && tok.trim()) return { token: tok.trim() };
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
    k === "Credentials" || k === "token" || k === "Token" || k === "scimToken" || k === "SCIMToken" || k === "apiToken" || k === "ApiToken"
      ? undefined
      : val,
  );
  return { ...stripped, _harvestScrubbed: true };
}
