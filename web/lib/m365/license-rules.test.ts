import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLicenseRules, normalizeLicenseRules } from "./license-rules";

const RULES = [
  { when: "needsComputer == true", licenses: ["Microsoft 365 E5"] },
  { when: "", licenses: ["Office 365 E1"] }, // default
];

test("first matching rule wins (computer needed → E5)", () => {
  assert.deepEqual(evaluateLicenseRules(RULES, { needsComputer: true }), ["Microsoft 365 E5"]);
});

test("falls through to the empty-when default (no computer → E1)", () => {
  assert.deepEqual(evaluateLicenseRules(RULES, { needsComputer: false }), ["Office 365 E1"]);
});

test("no default + no match → null (leave config.licenses untouched)", () => {
  assert.equal(evaluateLicenseRules([{ when: "needsComputer == true", licenses: ["E5"] }], { needsComputer: false }), null);
});

test("non-array / empty / malformed → null", () => {
  assert.equal(evaluateLicenseRules(null, {}), null);
  assert.equal(evaluateLicenseRules([], {}), null);
  assert.equal(evaluateLicenseRules([{ when: "title == X" }], { title: "X" }), null); // no licenses
});

test("normalize drops licence-less rules + trims/dedupes", () => {
  const n = normalizeLicenseRules([
    { when: "a == b", licenses: ["E5 ", "E5", ""] },
    { licenses: [] },
    "garbage",
  ]);
  assert.deepEqual(n, [{ when: "a == b", licenses: ["E5"] }]);
});

test("richer condition (department) selects correctly", () => {
  const rules = [
    { when: "department ~= Engineering", licenses: ["Microsoft 365 E5"] },
    { when: "employmentType == Contractor", licenses: ["Microsoft 365 F3"] },
    { when: "", licenses: ["Office 365 E1"] },
  ];
  assert.deepEqual(evaluateLicenseRules(rules, { department: "Engineering" }), ["Microsoft 365 E5"]);
  assert.deepEqual(evaluateLicenseRules(rules, { department: "Sales", employmentType: "Contractor" }), ["Microsoft 365 F3"]);
  assert.deepEqual(evaluateLicenseRules(rules, { department: "Sales" }), ["Office 365 E1"]);
});
