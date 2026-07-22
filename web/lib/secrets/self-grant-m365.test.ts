import { test } from "node:test";
import assert from "node:assert/strict";
import { canSelfGrant, rolesToSelfGrant, SELF_GRANT_ROLE } from "./self-grant-m365";
import { GRAPH_REQUIRED_CAPS, suggestedRole } from "./graph-caps";

test("canSelfGrant: detects AppRoleAssignment.ReadWrite.All case-insensitively", () => {
  assert.equal(canSelfGrant(["approleassignment.readwrite.all"]), true);
  assert.equal(canSelfGrant(["AppRoleAssignment.ReadWrite.All", "User.ReadWrite.All"]), true);
  assert.equal(canSelfGrant(["User.ReadWrite.All"]), false);
  assert.equal(canSelfGrant([]), false);
});

test("rolesToSelfGrant: returns the missing REQUIRED caps' suggested roles", () => {
  // Granted only the self-grant role → every required cap is missing.
  const roles = rolesToSelfGrant([SELF_GRANT_ROLE]);
  assert.deepEqual(roles, GRAPH_REQUIRED_CAPS.map(suggestedRole));
});

test("rolesToSelfGrant: a broader granted role satisfies a required cap (anyOf-aware)", () => {
  // Directory.ReadWrite.All covers all three required caps, so nothing is missing.
  const roles = rolesToSelfGrant(["Directory.ReadWrite.All", SELF_GRANT_ROLE]);
  assert.deepEqual(roles, []);
});

test("rolesToSelfGrant: folds in requested optional roles that aren't already granted", () => {
  const optional = "UserAuthenticationMethod.ReadWrite.All";
  const roles = rolesToSelfGrant(["Directory.ReadWrite.All"], [optional]);
  assert.deepEqual(roles, [optional]);
});

test("rolesToSelfGrant: drops an optional role that's already granted", () => {
  const optional = "UserAuthenticationMethod.ReadWrite.All";
  const roles = rolesToSelfGrant(["Directory.ReadWrite.All", optional], [optional]);
  assert.deepEqual(roles, []);
});

test("rolesToSelfGrant: dedupes when a required suggestedRole is also passed as optional", () => {
  const req = suggestedRole(GRAPH_REQUIRED_CAPS[0]);
  const roles = rolesToSelfGrant([SELF_GRANT_ROLE], [req]);
  // req appears once even though it's both a required gap and an explicit optional request.
  assert.equal(roles.filter((r) => r === req).length, 1);
});
