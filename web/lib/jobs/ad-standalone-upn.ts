// Hand the ON-PREM lane of an ad-standalone client its own userPrincipalName (FR #83 / #107).
//
// Applied at dispatch, alongside the writebackEmail and cloudObject overrides, so the AD module needs
// no change at all — it keeps reading $User.UserPrincipalName and simply receives the right value.
// A no-op for every client except a standalone one with identity.adDomain set (see adUpnFor).
import { adUpnFor } from "../profiles/ad-domain";
import { ALWAYS_ON_PREM_SYSTEMS } from "../cases/case-secrets";

export function applyAdStandaloneUpn(
  payload: Record<string, unknown>,
  systemKey: string,
  client: { backbone?: string | null; identity?: unknown } | null | undefined
): Record<string, unknown> {
  if (!client || !ALWAYS_ON_PREM_SYSTEMS.includes(systemKey)) return payload;
  const ad = adUpnFor(payload, client);
  if (!ad) return payload;
  return { ...payload, userPrincipalName: ad.upn, userPrincipalNameFallbacks: ad.fallbacks };
}
