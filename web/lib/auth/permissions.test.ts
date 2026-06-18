import { test } from "node:test";
import assert from "node:assert/strict";
import { can, permissionsFor, ALL_PERMISSIONS, canResetPassword, canAssignRole } from "./permissions";

test("password reset: super resets anyone; global resets global-or-lower but NOT a super", () => {
  // super_admin -> everyone, including other supers
  assert.ok(canResetPassword("super_admin", "super_admin"));
  assert.ok(canResetPassword("super_admin", "global_admin"));
  assert.ok(canResetPassword("super_admin", "auditor"));
  // global_admin -> global and below, but never a super
  assert.ok(canResetPassword("global_admin", "global_admin"));
  assert.ok(canResetPassword("global_admin", "engineer"));
  assert.ok(!canResetPassword("global_admin", "super_admin"));
  // below global can't reset anyone (no user.manage)
  assert.ok(!canResetPassword("ops_manager", "engineer"));
  assert.ok(!canResetPassword("engineer", "engineer"));
  assert.ok(!canResetPassword("auditor", "auditor"));
});

test("role assignment: only a super can grant or change the super tier", () => {
  assert.ok(canAssignRole("super_admin", "engineer", "super_admin")); // super promotes to super
  assert.ok(canAssignRole("super_admin", "super_admin", "global_admin")); // super demotes a super
  assert.ok(!canAssignRole("global_admin", "engineer", "super_admin")); // global can't promote to super
  assert.ok(!canAssignRole("global_admin", "super_admin", "global_admin")); // global can't re-role a super
  assert.ok(canAssignRole("global_admin", "engineer", "global_admin")); // global re-roles a non-super as usual
  assert.ok(!canAssignRole("ops_manager", "engineer", "engineer")); // no user.manage -> no assignment
});

test("global_admin has every permission", () => {
  assert.equal(permissionsFor("global_admin").length, ALL_PERMISSIONS.length);
  for (const p of ALL_PERMISSIONS) assert.ok(can("global_admin", p), p);
});

test("ops_manager can approve destructive + manage agents but not users/settings", () => {
  assert.ok(can("ops_manager", "case.approve_destructive"));
  assert.ok(can("ops_manager", "agent.manage"));
  assert.ok(can("ops_manager", "audit.view"));
  assert.ok(!can("ops_manager", "user.manage"));
  assert.ok(!can("ops_manager", "settings.manage"));
});

test("engineer runs cases but cannot self-approve destructive offboards (separation of duties)", () => {
  assert.ok(can("engineer", "case.dispatch"));
  assert.ok(can("engineer", "case.schedule"));
  assert.ok(can("engineer", "client.edit_secrets"));
  assert.ok(!can("engineer", "case.approve_destructive"));
  assert.ok(!can("engineer", "client.edit_systems"));
  assert.ok(!can("engineer", "agent.manage"));
});

test("importer can import + view, nothing else", () => {
  assert.deepEqual(permissionsFor("importer").sort(), ["case.import", "case.view"]);
  assert.ok(!can("importer", "case.dispatch"));
});

test("auditor is read-only with audit access", () => {
  assert.ok(can("auditor", "case.view"));
  assert.ok(can("auditor", "audit.view"));
  assert.ok(!can("auditor", "case.import"));
  assert.ok(!can("auditor", "case.dispatch"));
});
