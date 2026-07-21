import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIntakeRule, parseIntakeRules } from "./intake-rules";

const shawmut = {
  rules: [
    {
      id: "shawmut-infinite",
      label: "Shawmut Infinite (cloud-only)",
      match: { contacts: [{ sysId: "7750e1e447bdf29c3c5e88f4116d4393", name: "Angie Shropshire" }] },
      effects: { skipSystems: ["active-directory", "directory-sync"], forceDomain: "shawmutinfinite.com" },
    },
  ],
};

test("matches on requestedByContactSysId", () => {
  const m = matchIntakeRule(shawmut, { requestedByContactSysId: "7750e1e447bdf29c3c5e88f4116d4393" });
  assert.ok(m);
  assert.equal(m!.id, "shawmut-infinite");
  assert.equal(m!.forceDomain, "shawmutinfinite.com");
  assert.ok(m!.skipSystems.has("active-directory"));
  assert.ok(m!.skipSystems.has("directory-sync"));
});

test("matches on openedBySysId fallback", () => {
  const m = matchIntakeRule(shawmut, { openedBySysId: "7750e1e447bdf29c3c5e88f4116d4393" });
  assert.equal(m?.id, "shawmut-infinite");
});

test("no match for a different requester", () => {
  assert.equal(matchIntakeRule(shawmut, { requestedByContactSysId: "0000000000000000000000000000dead" }), null);
});

test("first matching rule wins", () => {
  const doc = {
    rules: [
      { id: "a", label: "A", match: { contacts: [{ sysId: "aa", name: "x" }] }, effects: { skipSystems: ["s1"], forceDomain: "a.com" } },
      { id: "b", label: "B", match: { contacts: [{ sysId: "aa", name: "x" }] }, effects: { skipSystems: ["s2"], forceDomain: "b.com" } },
    ],
  };
  assert.equal(matchIntakeRule(doc, { requestedByContactSysId: "aa" })?.id, "a");
});

test("null / malformed rules → null", () => {
  assert.equal(matchIntakeRule(null, { requestedByContactSysId: "aa" }), null);
  assert.equal(matchIntakeRule({ rules: "nope" }, { requestedByContactSysId: "aa" }), null);
  assert.equal(matchIntakeRule({}, { requestedByContactSysId: "aa" }), null);
});

test("no requester keys on payload → null", () => {
  assert.equal(matchIntakeRule(shawmut, {}), null);
});

test("parseIntakeRules tolerates junk", () => {
  assert.deepEqual(parseIntakeRules(undefined), { rules: [] });
  assert.deepEqual(parseIntakeRules({ rules: [{ id: "x" }] }).rules.length, 1);
});
