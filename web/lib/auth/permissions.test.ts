import { test } from "node:test";
import assert from "node:assert/strict";
import { can, permissionsFor, ALL_PERMISSIONS } from "./permissions";

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
