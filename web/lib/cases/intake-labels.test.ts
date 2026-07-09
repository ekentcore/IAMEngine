import { test } from "node:test";
import assert from "node:assert/strict";
import { intakeLabel } from "./intake-labels";

test("intakeLabel uses the friendly map for known keys", () => {
  assert.equal(intakeLabel("mobilePhone"), "Mobile phone");
  assert.equal(intakeLabel("dateOfOffboarding"), "Offboarding date");
  assert.equal(intakeLabel("mirrorPermissionsFromUser"), "Mirror permissions from");
});

test("intakeLabel humanizes unknown camelCase / snake_case keys", () => {
  assert.equal(intakeLabel("someNewField"), "Some New Field");
  assert.equal(intakeLabel("a_snake_case_key"), "A snake case key");
  assert.equal(intakeLabel("x"), "X");
});
