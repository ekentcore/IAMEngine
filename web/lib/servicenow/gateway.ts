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

// Build SnConfig from environment (server-side only).
export function snConfigFromEnv(): SnConfig {
  return {
    instanceUrl: process.env.SN_INSTANCE_URL ?? "",
    username: process.env.SN_USER ?? process.env.SN_USERNAME ?? "",
    password: process.env.SN_PASSWORD ?? "",
  };
}
