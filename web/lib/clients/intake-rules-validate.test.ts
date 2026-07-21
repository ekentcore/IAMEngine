import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIntakeRulesBody } from "./intake-rules-validate";

test("accepts a well-formed doc", () => {
  const r = validateIntakeRulesBody({
    rules: [{
      id: "shawmut-infinite", label: "Shawmut Infinite",
      match: { contacts: [{ sysId: "7750e1e447bdf29c3c5e88f4116d4393", name: "Angie Shropshire" }] },
      effects: { skipSystems: ["active-directory"], forceDomain: "shawmutinfinite.com" },
    }],
  });
  assert.equal(r.ok, true);
});

test("rejects an implausible forceDomain", () => {
  const r = validateIntakeRulesBody({
    rules: [{ id: "x", label: "x", match: { contacts: [{ sysId: "aa", name: "n" }] }, effects: { skipSystems: [], forceDomain: "not a domain" } }],
  });
  assert.equal(r.ok, false);
});

test("rejects a rule with no contacts", () => {
  const r = validateIntakeRulesBody({
    rules: [{ id: "x", label: "x", match: { contacts: [] }, effects: { skipSystems: ["m365"], forceDomain: null } }],
  });
  assert.equal(r.ok, false);
});

test("empty rules is valid (clears the config)", () => {
  assert.equal(validateIntakeRulesBody({ rules: [] }).ok, true);
});
