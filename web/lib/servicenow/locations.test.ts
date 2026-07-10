import { test } from "node:test";
import assert from "node:assert/strict";
import { toLocationsMap, type CmnLocation } from "./locations";

test("toLocationsMap: keys by name, keeps street/city/state/zip/timezone/country, drops empties", () => {
  const rows: CmnLocation[] = [
    { name: "FalconBOS", address: "21 Custom House St, 10th Floor", city: "Boston", state: "MA", zip: "02110", country: "US", timezone: "US/Eastern" },
    { name: "FalconNYC", address: null, city: "New York", state: "NY", zip: null, country: "US", timezone: "US/Eastern" },
  ];
  const map = toLocationsMap(rows);
  assert.deepEqual(map.FalconBOS, {
    address: "21 Custom House St, 10th Floor", city: "Boston", state: "MA", zip: "02110", timezone: "US/Eastern", country: { short: "US" },
  });
  // Boston is Eastern now (was Pacific from the generator) — the whole point of the sync.
  assert.equal((map.FalconBOS as { timezone: string }).timezone, "US/Eastern");
  // empty fields are omitted, not stored as null
  assert.deepEqual(map.FalconNYC, { city: "New York", state: "NY", timezone: "US/Eastern", country: { short: "US" } });
  assert.ok(!("address" in (map.FalconNYC as object)));
});
