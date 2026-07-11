import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLicenseEntries, isGroupBased, licenseEntryName } from "./license-config";

test("string entries: trimmed, empties dropped, case-insensitively deduped", () => {
  const r = parseLicenseEntries([" Microsoft 365 E3 ", "", "microsoft 365 e3", "SPE_E5"]);
  assert.ok(r.ok);
  assert.deepEqual(r.licenses, ["Microsoft 365 E3", "SPE_E5"]);
});

test("group-based entry: validated and normalized, groupSource defaults to entra", () => {
  const r = parseLicenseEntries([{ name: " Microsoft 365 E5 ", assignVia: "group", group: " E5 License Users " }]);
  assert.ok(r.ok);
  assert.deepEqual(r.licenses, [{ name: "Microsoft 365 E5", assignVia: "group", group: "E5 License Users", groupSource: "entra" }]);
});

test("mixed direct + group-based entries survive together", () => {
  const r = parseLicenseEntries(["SPE_E3", { name: "E5", assignVia: "group", group: "G", groupSource: "ad" }]);
  assert.ok(r.ok);
  assert.equal(r.licenses.length, 2);
  assert.ok(isGroupBased(r.licenses[1]));
  assert.equal(licenseEntryName(r.licenses[1]), "E5");
});

test("legacy { name, skuId } direct objects round-trip unharmed (no collapse to bare name)", () => {
  const r = parseLicenseEntries([{ name: "E3", skuId: "abc-123" }, { name: "Visio" }]);
  assert.ok(r.ok);
  assert.deepEqual(r.licenses, [{ name: "E3", skuId: "abc-123" }, { name: "Visio" }]);
});

test("a mixed legacy + group-based array parses (neither entry lost)", () => {
  const r = parseLicenseEntries([{ name: "E3", skuId: "abc" }, { name: "E5", assignVia: "group", group: "G" }]);
  assert.ok(r.ok);
  assert.equal(r.licenses.length, 2);
  assert.ok(isGroupBased(r.licenses[1]));
});

test("rejects: non-array, wrong assignVia, missing name/group, bad groupSource, junk entries", () => {
  assert.equal(parseLicenseEntries("nope").ok, false);
  assert.equal(parseLicenseEntries([{ skuId: "" }]).ok, false); // object with neither name nor skuId
  assert.equal(parseLicenseEntries([{ assignVia: "group", group: "G" }]).ok, false);
  assert.equal(parseLicenseEntries([{ name: "E5", assignVia: "group" }]).ok, false);
  assert.equal(parseLicenseEntries([{ name: "E5", assignVia: "group", group: "G", groupSource: "azure" }]).ok, false);
  assert.equal(parseLicenseEntries([{ name: "E5", assignVia: "direct" }]).ok, false);
  assert.equal(parseLicenseEntries([42]).ok, false);
});

test("one entry per license name, first wins — across kinds too (a license is assigned one way)", () => {
  const r = parseLicenseEntries([
    "Microsoft 365 E5",
    { name: "microsoft 365 e5", assignVia: "group", group: "G1" }, // same name, different kind — dropped
    { name: "E5", assignVia: "group", group: "G1" },
    { name: "e5", assignVia: "group", group: "G2" },               // same name, different group — dropped
  ]);
  assert.ok(r.ok);
  assert.deepEqual(r.licenses, ["Microsoft 365 E5", { name: "E5", assignVia: "group", group: "G1", groupSource: "entra" }]);
});
