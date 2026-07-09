import { test } from "node:test";
import assert from "node:assert/strict";
import { detectKbAction } from "./runbook-parse";

test("title with 'onboarding' → onboard", () => {
  assert.equal(detectKbAction("User Onboarding — Acme", "anything"), "onboard");
});

test("title with 'offboarding'/'termination' → offboard", () => {
  assert.equal(detectKbAction("User Offboarding", ""), "offboard");
  assert.equal(detectKbAction("Employee Termination Procedure", ""), "offboard");
});

test("untitled onboarding body scores onboard", () => {
  const body = "Create the new user. Add user to groups. Assign default licensing. Send the new user's credentials.";
  assert.equal(detectKbAction("KB0019791", body), "onboard");
});

test("untitled offboarding body scores offboard", () => {
  const body = "Disable the account. Remove the user from all groups. Revoke sessions. Convert mailbox to shared. Hide from GAL.";
  assert.equal(detectKbAction("KB0020000", body), "offboard");
});

test("ambiguous / weak text → null (don't auto-switch on a guess)", () => {
  assert.equal(detectKbAction("KB0001", "See the linked document."), null);
});
