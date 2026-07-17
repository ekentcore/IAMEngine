import { test } from "node:test";
import assert from "node:assert/strict";
import { requirePermission, requireUser, AuthError } from "./guard";

// The auth-off synthetic-admin pass-through is the rollout mechanism (AUTH_ENABLED unset = today's
// behavior) — EXCEPT for destructive approvals, which must fail closed in every environment: with the
// pass-through, anyone on the network could release a destructive offboard step under a fabricated
// approver name. This is the authoritative gate; the middleware 503 is defense-in-depth.
test("auth off: case.approve_destructive fails closed instead of passing as SYSTEM", async () => {
  const prev = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = "";
  try {
    await assert.rejects(
      () => requirePermission("case.approve_destructive"),
      (e: unknown) => e instanceof AuthError && e.status === 403,
    );
  } finally {
    process.env.AUTH_ENABLED = prev;
  }
});

test("auth off: ordinary permissions still pass through as the synthetic system admin", async () => {
  const prev = process.env.AUTH_ENABLED;
  process.env.AUTH_ENABLED = "";
  try {
    const u = await requirePermission("case.dispatch");
    assert.equal(u.system, true);
    assert.equal(u.role, "super_admin");
    const r = await requireUser();
    assert.equal(r.system, true);
  } finally {
    process.env.AUTH_ENABLED = prev;
  }
});
