// Sync a client's offices from ServiceNow's cmn_location table into Client.locations — the authoritative
// source (all sites, real street addresses, correct time zones), replacing the fleet generator's
// LLM-guessed locations (which mis-assigned timezones, e.g. Boston → Pacific). Manual refresh only.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

const TABLE = "/api/now/table/cmn_location";

export type CmnLocation = {
  name: string;
  address: string | null; // street
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  timezone: string | null; // as SN stores it (IANA "US/Eastern" or a Windows display) — shown as-is
};

// display_value (readable) with a value fallback; trimmed, null when empty.
const field = (r: Record<string, SnFieldValue>, k: string): string | null => {
  const raw = r[k]?.display_value ?? r[k]?.value;
  const v = raw == null ? "" : String(raw).trim();
  return v || null;
};

// Fetch the account's location records. Filters by company OR account (the two ways cmn_location is
// commonly linked) — if your instance links differently and this returns none, tell me the field.
// The sys_id is validated (32 hex) before interpolating into sysparm_query (injection guard).
export async function fetchCmnLocations(config: SnConfig, accountSysId: string, fetcher: typeof fetch = fetch): Promise<CmnLocation[]> {
  assertConfig(config);
  if (!/^[0-9a-f]{32}$/i.test(accountSysId)) return [];
  const rows = await snGet<Array<Record<string, SnFieldValue>>>(
    config,
    TABLE,
    {
      sysparm_query: `company=${accountSysId}^ORaccount=${accountSysId}`,
      sysparm_fields: "name,street,city,state,zip,country,time_zone",
      sysparm_display_value: "all",
      sysparm_limit: "200",
    },
    fetcher,
  );
  return rows
    .map((r) => ({
      name: field(r, "name") ?? "",
      address: field(r, "street"),
      city: field(r, "city"),
      state: field(r, "state"),
      zip: field(r, "zip"),
      country: field(r, "country"),
      timezone: field(r, "time_zone"),
    }))
    .filter((l) => l.name);
}

// Shape the records into the Client.locations map: { <name>: { address, city, state, zip, timezone,
// country: { short } } }. Omits empty fields. Pure + testable — the DB write lives in refresh-locations.
export function toLocationsMap(rows: CmnLocation[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const l of rows) {
    const e: Record<string, unknown> = {};
    if (l.address) e.address = l.address;
    if (l.city) e.city = l.city;
    if (l.state) e.state = l.state;
    if (l.zip) e.zip = l.zip;
    if (l.timezone) e.timezone = l.timezone;
    if (l.country) e.country = { short: l.country };
    out[l.name] = e;
  }
  return out;
}
