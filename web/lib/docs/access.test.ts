import { test } from "node:test";
import assert from "node:assert/strict";
import { canViewAudience, canViewDocs, canManageDocs } from "./access";

test("client docs are visible to engineer and above, not below", () => {
  for (const r of ["engineer", "ops_manager", "global_admin", "super_admin"] as const) assert.ok(canViewAudience(r, "client"), r);
  for (const r of ["importer", "auditor"] as const) assert.ok(!canViewAudience(r, "client"), r);
});

test("internal docs are visible to global_admin and above only", () => {
  for (const r of ["global_admin", "super_admin"] as const) assert.ok(canViewAudience(r, "internal"), r);
  for (const r of ["engineer", "ops_manager", "importer", "auditor"] as const) assert.ok(!canViewAudience(r, "internal"), r);
});

test("canViewDocs matches engineer+ (the client-doc floor)", () => {
  assert.ok(canViewDocs("engineer"));
  assert.ok(!canViewDocs("importer"));
});

test("managing docs (AI update / publish) is global_admin and above only", () => {
  assert.ok(canManageDocs("global_admin"));
  assert.ok(canManageDocs("super_admin"));
  assert.ok(!canManageDocs("ops_manager"));
  assert.ok(!canManageDocs("engineer"));
});
