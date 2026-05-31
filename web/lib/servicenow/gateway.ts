// ServiceNow gateway: the only place that talks HTTP to ServiceNow.
// Single responsibility — fetch raw customer_account records for the in-scope roster.
// No Prisma, no mapping. Reused later (Phase 3) for work-note write-back.
import type { SnAccount, SnConfig, SnListResponse } from "./types";

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
const REQUEST_TIMEOUT_MS = 15_000; // don't let a slow/unreachable SN hang a page render

export class SnGatewayError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly body?: string) {
    super(message);
    this.name = "SnGatewayError";
  }
}

// Allow injecting a custom fetch in tests; default to the global.
type Fetcher = typeof fetch;

function authHeader(config: SnConfig): string {
  const token = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  return `Basic ${token}`;
}

async function fetchPage(
  config: SnConfig,
  offset: number,
  fetcher: Fetcher
): Promise<SnAccount[]> {
  const url = new URL(`${config.instanceUrl}/api/now/table/customer_account`);
  url.searchParams.set("sysparm_query", ROSTER_QUERY);
  url.searchParams.set("sysparm_fields", FIELDS);
  url.searchParams.set("sysparm_display_value", "all");
  url.searchParams.set("sysparm_limit", String(PAGE_SIZE));
  url.searchParams.set("sysparm_offset", String(offset));

  let res: Response;
  try {
    res = await fetcher(url.toString(), {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SnGatewayError(`ServiceNow request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new SnGatewayError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SnGatewayError(
      `ServiceNow returned ${res.status} ${res.statusText}`,
      res.status,
      body.slice(0, 500)
    );
  }

  const json = (await res.json()) as SnListResponse<SnAccount>;
  return json.result ?? [];
}

// Fetch every in-scope account, paginating until a short page signals the end.
export async function fetchSnAccounts(
  config: SnConfig,
  fetcher: Fetcher = fetch
): Promise<SnAccount[]> {
  if (!config.instanceUrl || !config.username || !config.password) {
    throw new SnGatewayError("ServiceNow config incomplete (instanceUrl/username/password)");
  }

  const all: SnAccount[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(config, offset, fetcher);
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
