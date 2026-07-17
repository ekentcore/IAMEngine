import { test } from "node:test";
import assert from "node:assert/strict";
import { stableEqual, clientSystemMatches, type SeedSystemFields } from "./seed-guard";

test("stableEqual ignores object key order but not array order", () => {
  assert.equal(stableEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
  assert.equal(stableEqual([1, 2], [2, 1]), false);
  assert.equal(stableEqual(null, null), true);
  assert.equal(stableEqual(null, {}), false);
  assert.equal(stableEqual("x", "x"), true);
});

// JSON semantics: an undefined-valued key IS an absent key. The seed's literals carry them freely
// (`{ onboard: s.onboard?.dependsOn, offboard: s.offboard?.dependsOn }`) and the JSONB round trip
// drops them — counting them made every freshly-seeded row read as "DB-edited" on the next run.
test("stableEqual treats undefined-valued keys as absent (JSONB round-trip survives)", () => {
  assert.equal(stableEqual({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(stableEqual({ onboard: undefined, offboard: undefined }, {}), true);
  const literal = { onboard: null, dependsOn: { onboard: undefined, offboard: ["m365"] } };
  assert.equal(stableEqual(JSON.parse(JSON.stringify(literal)), literal), true, "a value must equal its own round trip");
  assert.equal(stableEqual({ a: undefined }, { a: null }), false, "an explicit null is a VALUE, not absence");
});

const base: SeedSystemFields = {
  mode: "api",
  onboardWhen: "always",
  offboardWhen: "always",
  dependsOn: ["m365"],
  requiresApproval: false,
  captureEvidence: false,
  secretNames: ["m365-admin"],
  config: { onboard: null, offboard: { removeLicense: {} }, dependsOn: {}, requiresApproval: { onboard: false, offboard: false }, captureEvidence: { onboard: false, offboard: false } },
};

test("a row identical to the seed values matches (reseed stays a no-op)", () => {
  const dbRow = JSON.parse(JSON.stringify(base)) as SeedSystemFields;
  // Simulate Prisma returning the JSON with different key order.
  dbRow.config = { offboard: { removeLicense: {} }, onboard: null, captureEvidence: { offboard: false, onboard: false }, requiresApproval: { offboard: false, onboard: false }, dependsOn: {} };
  assert.equal(clientSystemMatches(dbRow, base), true);
});

// The exact incident this guard exists for: the licence sweep wrote offboard config into the DB that
// the profiles don't have — a reseed must see the difference and keep the DB values.
test("a DB-side config edit makes the row NOT match, so the seed keeps it", () => {
  const dbRow = JSON.parse(JSON.stringify(base)) as SeedSystemFields;
  (dbRow.config as { offboard: Record<string, unknown> }).offboard = {
    blockSignIn: true, removeAllGroups: true, mailbox: { sizeThresholdGB: 50 },
    removeLicense: { defer: true, removedBy: "entra" },
  };
  assert.equal(clientSystemMatches(dbRow, base), false);
});

test("null and missing config are the same thing; a real config is not", () => {
  const noCfgDb = { ...base, config: null };
  const noCfgSeed = { ...base, config: undefined };
  assert.equal(clientSystemMatches(noCfgDb, noCfgSeed), true);
  assert.equal(clientSystemMatches(noCfgDb, base), false);
});

test("column-level edits (mode, lanes, deps, secrets) are all seen", () => {
  assert.equal(clientSystemMatches({ ...base, mode: "manual" }, base), false);
  assert.equal(clientSystemMatches({ ...base, offboardWhen: "never" }, base), false);
  assert.equal(clientSystemMatches({ ...base, dependsOn: ["m365", "exchange"] }, base), false);
  assert.equal(clientSystemMatches({ ...base, secretNames: [] }, base), false);
  assert.equal(clientSystemMatches({ ...base, requiresApproval: true }, base), false);
});
