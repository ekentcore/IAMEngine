// List an M365 tenant's VERIFIED domains via Graph — the authoritative set of valid UPN suffixes
// for that tenant (better than inferring from contact addresses). Client-credentials flow with the
// same app-registration credential the m365 executor uses. Requires the app registration to hold
// the Domain.Read.All APPLICATION permission; a 403 comes back as an actionable grant message.

export type TenantDomain = { name: string; isDefault: boolean; isVerified: boolean };
export type TenantDomainsResult = { ok: true; domains: TenantDomain[] } | { ok: false; error: string };

export async function listTenantDomains(
  tenant: string,
  appId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch
): Promise<TenantDomainsResult> {
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });
    const tok = await fetcher(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!tok.ok) {
      const d = (await tok.json().catch(() => null)) as { error?: string; error_description?: string } | null;
      const code = d?.error_description?.match(/AADSTS\d+/)?.[0] ?? d?.error ?? `HTTP ${tok.status}`;
      return { ok: false, error: `could not sign in with the m365-admin app registration (${code})` };
    }
    const accessToken = ((await tok.json()) as { access_token?: string }).access_token;
    if (!accessToken) return { ok: false, error: "token endpoint returned no access token" };

    const res = await fetcher("https://graph.microsoft.com/v1.0/domains?$select=id,isDefault,isVerified", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 403) {
      return { ok: false, error: "the app registration lacks the Domain.Read.All application permission — grant it (admin consent) to pull the tenant's domain list" };
    }
    if (!res.ok) return { ok: false, error: `Graph /domains returned HTTP ${res.status}` };
    const data = (await res.json().catch(() => null)) as { value?: Array<{ id?: string; isDefault?: boolean; isVerified?: boolean }> } | null;
    if (!data?.value) return { ok: false, error: "Graph /domains returned no domain list" };
    const domains = data.value
      .filter((d) => typeof d.id === "string" && d.id)
      .map((d) => ({ name: (d.id as string).toLowerCase(), isDefault: Boolean(d.isDefault), isVerified: Boolean(d.isVerified) }))
      // onmicrosoft.com routing domains are technically verified but never a mail identity choice
      .filter((d) => d.isVerified && !d.name.endsWith(".onmicrosoft.com"));
    return { ok: true, domains };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
