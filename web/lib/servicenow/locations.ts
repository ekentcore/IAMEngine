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

// Timezone, region stripped to just the zone: "US/Central" → "Central", "Canada/Central" → "Central",
// "Eastern Standard Time" → "Eastern". Leaves offsets ("UTC-05:00") and unknown forms untouched.
export function normalizeTz(tz: string | null): string | null {
  if (!tz) return null;
  let z = tz.trim();
  if (z.includes("/")) z = z.split("/").pop()!.trim(); // drop US/ Canada/ America/ …
  z = z.replace(/\s+(Standard|Daylight)\s+Time$/i, "").trim(); // Windows display → zone word
  return z || tz;
}

// The display NAME for a location: the part after the last "/" in the ServiceNow name (usually the
// city), falling back to the city field then the raw name. e.g. "21 Custom House St / Boston" → "Boston".
function baseName(l: CmnLocation): string {
  const afterSlash = l.name.includes("/") ? l.name.split("/").pop()!.trim() : "";
  return afterSlash || l.city || l.name;
}

// Shape the records into the Client.locations map: { <name>: { address, city, state, zip, timezone,
// country: { short } } }. Names come from baseName; when two offices share a base (same city), they're
// disambiguated as "City - <street>". Timezones are region-stripped. Pure — the DB write lives in
// refresh-locations. Empty fields are omitted.
export function toLocationsMap(rows: CmnLocation[]): Record<string, Record<string, unknown>> {
  const baseCounts = new Map<string, number>();
  for (const l of rows) baseCounts.set(baseName(l), (baseCounts.get(baseName(l)) ?? 0) + 1);

  const out: Record<string, Record<string, unknown>> = {};
  for (const l of rows) {
    const base = baseName(l);
    // Same city more than once → "City - Street" so each office is distinguishable.
    let name = baseCounts.get(base)! > 1 && l.address ? `${base} - ${l.address}` : base;
    // Last-ditch de-collision (identical base + street, or missing street) so we never drop a row.
    if (out[name]) { let i = 2; while (out[`${name} (${i})`]) i++; name = `${name} (${i})`; }

    const e: Record<string, unknown> = {};
    if (l.address) e.address = l.address;
    if (l.city) e.city = l.city;
    if (l.state) e.state = l.state;
    if (l.zip) e.zip = l.zip;
    const tz = normalizeTz(l.timezone);
    if (tz) e.timezone = tz;
    if (l.country) e.country = { short: l.country };
    out[name] = e;
  }
  return out;
}
