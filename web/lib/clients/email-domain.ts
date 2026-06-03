// Resolve the email/UPN domain to use for a case, layering the three tiers of authority the team
// chose: a per-case override (the engineer's final say at run time) → a human-locked curated value
// → the dominant domain of the client's ServiceNow contacts (ground truth, cached) → the cached
// value → the website domain (last resort). Pure orchestration over injected I/O so it unit-tests
// without ServiceNow or a DB.
import { dominantEmailDomain, emailDomainOf, isPlausibleDomain } from "../servicenow/email-domain";

export type ResolveDeps = {
  fetchContactEmails: (accountSysId: string) => Promise<string[]>;
  setEmailDomain: (clientId: string, domain: string) => Promise<void>;
};

export type ResolveClient = {
  id: string;
  primaryDomain: string;
  emailDomain: string | null;
  emailDomainLocked: boolean;
  serviceNowSysId: string | null;
};

export type ResolveResult = { domain: string; source: "override" | "locked" | "contacts" | "cached" | "website" };

// Accept either a bare domain ("acme.com") or a full address ("jane@acme.com" / "@acme.com").
// Returns null for anything that isn't a plausible domain (junk like "acme..com", "acme. com",
// "1.2", a URL) — callers must treat null as "reject", not "ignore".
export function normalizeDomainInput(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("@")) return emailDomainOf(v.startsWith("@") ? `x${v}` : v);
  const d = v.replace(/\.+$/, "");
  return isPlausibleDomain(d) ? d : null;
}

export async function resolveEmailDomain(
  deps: ResolveDeps,
  input: { client: ResolveClient; override?: string | null }
): Promise<ResolveResult> {
  const { client } = input;

  // 1. Per-case override — wins, but is NOT persisted (it applies to this case only).
  const override = normalizeDomainInput(input.override);
  if (override) return { domain: override, source: "override" };

  // 2. Human-locked curated value — never re-derived/overwritten.
  if (client.emailDomainLocked && client.emailDomain) {
    return { domain: client.emailDomain, source: "locked" };
  }

  // 3. Derive from the account's contacts (ground truth) and cache it. Best-effort: a ServiceNow
  // outage must not block planning — fall through to the cached/website value instead.
  if (client.serviceNowSysId) {
    let emails: string[] = [];
    try {
      emails = await deps.fetchContactEmails(client.serviceNowSysId);
    } catch {
      emails = [];
    }
    const pick = dominantEmailDomain(emails);
    if (pick.domain) {
      if (pick.domain !== client.emailDomain) {
        try {
          await deps.setEmailDomain(client.id, pick.domain);
        } catch {
          // caching is best-effort; still return the freshly-derived domain.
        }
      }
      return { domain: pick.domain, source: "contacts" };
    }
  }

  // 4. A previously-cached derived value.
  if (client.emailDomain) return { domain: client.emailDomain, source: "cached" };

  // 5. Last resort: the website domain.
  return { domain: client.primaryDomain, source: "website" };
}
