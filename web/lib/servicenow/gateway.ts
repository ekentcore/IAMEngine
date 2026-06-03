// ServiceNow roster gateway: fetch raw customer_account records for the in-scope roster.
// No Prisma, no mapping. Reused later (Phase 3) for work-note write-back.
import type { SnAccount, SnConfig } from "./types";
import { snGet, assertConfig, SnGatewayError } from "./http";

export { SnGatewayError };

// In-scope roster: active customers with an onboarding OR offboarding rating of 1/2/3.
// (matches the count of ~182 verified against the live instance)
const ROSTER_QUERY =
  "customer=true^active=true^u_onboardingIN1,2,3^ORu_offboardingIN1,2,3";

const FIELDS = [
  "sys_id",
  "u_core_id",
  "name",
  "website",
  "u_region",
  "u_time_zone",
  "u_support_status",
  "u_comanaged_it",
  "u_onboarding",
  "u_offboarding",
].join(",");

const PAGE_SIZE = 100;

type Fetcher = typeof fetch;

// Fetch every in-scope account, paginating until a short page signals the end.
export async function fetchSnAccounts(
  config: SnConfig,
  fetcher: Fetcher = fetch
): Promise<SnAccount[]> {
  assertConfig(config);

  const all: SnAccount[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await snGet<SnAccount[]>(
      config,
      "/api/now/table/customer_account",
      {
        sysparm_query: ROSTER_QUERY,
        sysparm_fields: FIELDS,
        sysparm_display_value: "all",
        sysparm_limit: String(PAGE_SIZE),
        sysparm_offset: String(offset),
      },
      fetcher
    );
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

// Email addresses of an account's ACTIVE contacts — the ground truth for the org's email domain
// (vs the website-derived primaryDomain). Paginated so a large account isn't silently truncated to
// a non-representative first page (which would skew the dominant-domain vote). display_value=false
// so each field is a plain string. Hard cap keeps a pathological account from looping forever.
const CONTACT_PAGE = 200;
const CONTACT_MAX = 2000;
export async function fetchAccountContactEmails(
  config: SnConfig,
  accountSysId: string,
  fetcher: Fetcher = fetch
): Promise<string[]> {
  if (!accountSysId) return [];
  assertConfig(config);
  const emails: string[] = [];
  for (let offset = 0; offset < CONTACT_MAX; offset += CONTACT_PAGE) {
    const page = await snGet<Array<{ email?: string | { value?: string } }>>(
      config,
      "/api/now/table/customer_contact",
      {
        sysparm_query: `account=${accountSysId}^active=true`,
        sysparm_fields: "email",
        sysparm_display_value: "false",
        sysparm_limit: String(CONTACT_PAGE),
        sysparm_offset: String(offset),
      },
      fetcher
    );
    for (const r of page) {
      const e = typeof r.email === "string" ? r.email : r.email?.value ?? "";
      if (e.trim() !== "") emails.push(e);
    }
    if (page.length < CONTACT_PAGE) break;
  }
  return emails;
}

// Build SnConfig from environment (server-side only).
export function snConfigFromEnv(): SnConfig {
  return {
    instanceUrl: process.env.SN_INSTANCE_URL ?? "",
    username: process.env.SN_USER ?? process.env.SN_USERNAME ?? "",
    password: process.env.SN_PASSWORD ?? "",
  };
}
