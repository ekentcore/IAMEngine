import { test } from "node:test";
import assert from "node:assert/strict";
import { iamCaseNumber, needsIamNumber } from "./case-number";

test("iamCaseNumber zero-pads to 7 digits with an IAM prefix", () => {
  assert.equal(iamCaseNumber(1), "IAM0000001");
  assert.equal(iamCaseNumber(42), "IAM0000042");
  assert.equal(iamCaseNumber(1234567), "IAM1234567");
});

test("iamCaseNumber widens past 7 digits rather than truncating into a collision", () => {
  assert.equal(iamCaseNumber(12345678), "IAM12345678");
});

test("needsIamNumber: only a real supplied number suppresses auto-assignment", () => {
  // manual case — nothing usable supplied → assign
  assert.equal(needsIamNumber(null), true);
  assert.equal(needsIamNumber(undefined), true);
  assert.equal(needsIamNumber(""), true);
  assert.equal(needsIamNumber("   "), true); // an empty New-case box must not win a slot
  // ServiceNow-sourced (or any real value) — keep it
  assert.equal(needsIamNumber("UM0029763"), false);
  assert.equal(needsIamNumber("IAM0000001"), false);
});
