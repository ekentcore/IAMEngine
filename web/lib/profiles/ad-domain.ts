// AD-STANDALONE domain separation (FR #83 / #107).
//
// An ad-standalone client runs on-prem AD and a SEPARATE, unsynced M365/Entra — two accounts for one
// person, managed independently. Such a client can have an on-prem namespace that is not its mail
// domain (Olympus - LittleRock - YEE: AD syee.local, mail olympuscosmetic.com), and until now there
// was no way to say so: planning-service resolves ONE domain (emailDomain ?? primaryDomain) and
// deriveIdentity builds the UPN for every lane from it.
//
// This returns the userPrincipalName the ON-PREM lane should be handed, or null for "change nothing".
//
// Null is the answer for everything except a standalone client with adDomain set — deliberately:
//   - ad_synced: the AD UPN and the cloud UPN are the SAME by definition (that is what syncing
//     means). Rewriting one would break the hard-match AD Connect relies on, across 42 clients.
//   - entra / google / unmodeled: there is no on-prem lane to give a different UPN to.
// The container/DN is NOT our business — the AD module resolves that live from the domain controller
// (Resolve-CtgAdDomain), which already handles the corp-vs-mail-domain split correctly.
import { deriveIdentity } from "../servicenow/intake-mapper";

// The profile schema spells it "ad-standalone"; the Prisma enum is "ad_standalone". Accept both so a
// profile-sourced value and a database-sourced value behave identically. Exported so other call
// sites (e.g. orchestrator.ts's synthetic-step guards) share this one definition instead of
// re-deriving their own literal comparison that could drift from this one.
export const STANDALONE = new Set(["ad_standalone", "ad-standalone"]);

export function adUpnFor(
  payload: Record<string, unknown>,
  client: { backbone?: string | null; identity?: unknown }
): { upn: string; fallbacks: string[] } | null {
  if (!STANDALONE.has(String(client.backbone ?? ""))) return null;
  const identity = (client.identity ?? {}) as { usernamePatterns?: string[] | null; adDomain?: unknown };
  const adDomain = typeof identity.adDomain === "string" ? identity.adDomain.trim() : "";
  if (!adDomain) return null;

  // Re-derive with the AD domain substituted for the mail domain, reusing the SAME pattern engine
  // that produced the cloud UPN — so tokens, the nickname rule, and the conflict fallbacks all behave
  // identically and cannot drift from the cloud lane's derivation.
  const derived = deriveIdentity({ ...payload }, {
    usernamePatterns: identity.usernamePatterns ?? null,
    primaryDomain: adDomain,
  });
  const upn = typeof derived.userPrincipalName === "string" ? derived.userPrincipalName : "";
  if (!upn) return null;
  const fallbacks = Array.isArray(derived.userPrincipalNameFallbacks)
    ? (derived.userPrincipalNameFallbacks as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  return { upn, fallbacks };
}

// A permissive DNS-name check — accepts a `.local` namespace (core2187's AD is syee.local) as well
// as a real public domain. Not a full RFC 1035 validator; just enough to reject obvious garbage
// ("not a domain", a URL, a path) before it lands in the identity blob.
const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Set (or clear) `identity.adDomain` for FR #83: "there's no way to specify that". `identity` also
// carries usernamePatterns, password, and whatever else a profile put there — this MERGES the one
// key in, so a client's other identity config survives the edit untouched. A blank/whitespace value
// CLEARS the field (deletes the key) rather than storing "". Throws (message mentions "domain") when
// the value doesn't look like a DNS name — the route turns that into a 422.
export function mergeAdDomain(identity: unknown, value: string): Record<string, unknown> {
  const base: Record<string, unknown> =
    identity && typeof identity === "object" && !Array.isArray(identity) ? { ...(identity as Record<string, unknown>) } : {};
  const trimmed = value.trim();
  if (!trimmed) {
    delete base.adDomain;
    return base;
  }
  if (!DNS_NAME.test(trimmed)) {
    throw new Error(`adDomain must look like a domain name (e.g. syee.local): "${value}"`);
  }
  base.adDomain = trimmed;
  return base;
}
