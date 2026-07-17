import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLocationTargets, applyLocationTargets } from "./location-targets";

test("classify: discovered names → groups, rest → printers", () => {
  const out = classifyLocationTargets(
    ["FalconBOS", "HP-Reception", "FIA-Sec"],
    ["FalconBOS", "FIA-Sec", "Something-Else"],
  );
  assert.deepEqual(out.groups, ["FalconBOS", "FIA-Sec"]);
  assert.deepEqual(out.printers, ["HP-Reception"]);
});

test("classify: empty discovery keeps everything as groups (never guess)", () => {
  const out = classifyLocationTargets(["A", "B"], []);
  assert.deepEqual(out.groups, ["A", "B"]);
  assert.deepEqual(out.printers, []);
});

test("classify: empty input → empty split", () => {
  const out = classifyLocationTargets([], ["A"]);
  assert.deepEqual(out, { groups: [], printers: [] });
});

test("apply: sets non-empty, deletes empty, preserves other keys", () => {
  const entry = { city: "Boston", groups: ["old"], printers: ["oldp"], ou: "OU=x", zip: "02110" };
  const out = applyLocationTargets(entry, { groups: ["G1"], printers: [], ou: "" });
  assert.equal(out.city, "Boston");
  assert.equal(out.zip, "02110");
  assert.deepEqual(out.groups, ["G1"]);
  assert.ok(!("printers" in out)); // empty ⇒ deleted
  assert.ok(!("ou" in out));       // empty ⇒ deleted
});

test("apply: does not mutate the input entry", () => {
  const entry = { groups: ["old"] };
  applyLocationTargets(entry, { groups: ["new"], printers: ["p"], ou: "" });
  assert.deepEqual(entry, { groups: ["old"] });
});
