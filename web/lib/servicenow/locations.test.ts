import { test } from "node:test";
import assert from "node:assert/strict";
import { toLocationsMap, normalizeTz, type CmnLocation } from "./locations";

test("normalizeTz strips the region/company, leaving the zone", () => {
  assert.equal(normalizeTz("US/Central"), "Central");
  assert.equal(normalizeTz("Canada/Central"), "Central");
  assert.equal(normalizeTz("US/Eastern"), "Eastern");
  assert.equal(normalizeTz("Eastern Standard Time"), "Eastern"); // Windows display
  assert.equal(normalizeTz("UTC-05:00"), "UTC-05:00"); // offset left alone
  assert.equal(normalizeTz(null), null);
});

test("toLocationsMap names from after the '/', region-stripped tz, empties dropped", () => {
  const rows: CmnLocation[] = [
    { name: "21 Custom House St / Boston", address: "21 Custom House St, 10th Floor", city: "Boston", state: "MA", zip: "02110", country: "US", timezone: "US/Eastern" },
    { name: "FalconNYC", address: null, city: "New York", state: "NY", zip: null, country: "US", timezone: "US/Eastern" },
  ];
  const map = toLocationsMap(rows);
  // "…/ Boston" → "Boston"; tz "US/Eastern" → "Eastern" (was Pacific from the generator)
  assert.deepEqual(map.Boston, { address: "21 Custom House St, 10th Floor", city: "Boston", state: "MA", zip: "02110", timezone: "Eastern", country: { short: "US" } });
  // no "/" in the name → falls back to the city field
  assert.ok(map["New York"], "falls back to city when the name has no slash");
  assert.ok(!("address" in (map["New York"] as object))); // empty fields omitted
});

test("toLocationsMap disambiguates two offices in the same city as 'City - Street'", () => {
  const rows: CmnLocation[] = [
    { name: "Main / Dallas", address: "100 Main St", city: "Dallas", state: "TX", zip: null, country: "US", timezone: "US/Central" },
    { name: "Elm / Dallas", address: "200 Elm St", city: "Dallas", state: "TX", zip: null, country: "US", timezone: "US/Central" },
  ];
  const map = toLocationsMap(rows);
  assert.ok(map["Dallas - 100 Main St"], "first Dallas office keyed by street");
  assert.ok(map["Dallas - 200 Elm St"], "second Dallas office keyed by street");
  assert.ok(!map.Dallas, "no bare 'Dallas' when there are two");
  assert.equal((map["Dallas - 100 Main St"] as { timezone: string }).timezone, "Central");
});
