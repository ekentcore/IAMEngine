import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fieldsBadge,
  accessBadge,
  apiBadge,
  rightsBadge,
  stageDetail,
  hasRights,
  type ConnTest,
} from "./conn-test-badge-logic";

// A pending test with all optional fields null — the baseline a fresh queued row starts from.
function base(overrides: Partial<ConnTest> = {}): ConnTest {
  return {
    systemKey: "m365",
    status: "pending",
    detail: null,
    accessOk: null,
    accessDetail: null,
    fieldsOk: null,
    fieldsDetail: null,
    rights: null,
    credExpiresAt: null,
    onPrem: false,
    finishedAt: null,
    ...overrides,
  };
}

test("fieldsBadge reflects the app-side field-shape check", () => {
  assert.deepEqual(fieldsBadge(base({ fieldsOk: true })), { text: "✓ fields ok", color: "#15803d" });
  assert.deepEqual(fieldsBadge(base({ fieldsOk: false })), { text: "✗ fields", color: "#b91c1c" });
  assert.deepEqual(fieldsBadge(base({ fieldsOk: null })), { text: "—", color: "var(--muted)" });
});

test("accessBadge advances queued → testing → resolved/no-access", () => {
  assert.equal(accessBadge(base({ status: "pending" })).text, "queued");
  assert.equal(accessBadge(base({ status: "running" })).text, "testing…");
  assert.deepEqual(accessBadge(base({ accessOk: true })), { text: "✓ resolved", color: "#15803d" });
  assert.deepEqual(accessBadge(base({ accessOk: false })), { text: "✗ no access", color: "#b91c1c" });
});

test("apiBadge is skipped when the secret never resolved, else reflects the live read", () => {
  assert.equal(apiBadge(base({ accessOk: false, status: "fail" })).text, "— skipped");
  assert.deepEqual(apiBadge(base({ status: "ok", accessOk: true })), { text: "✓ read ok", color: "#15803d" });
  assert.deepEqual(apiBadge(base({ status: "fail", accessOk: true })), { text: "✗ failed", color: "#b91c1c" });
  assert.equal(apiBadge(base({ status: "running", accessOk: true })).text, "testing…");
  assert.equal(apiBadge(base({ status: "pending" })).text, "queued");
});

test("rightsBadge summarizes required ops and never fails on optional/surplus", () => {
  assert.deepEqual(rightsBadge(base({ rights: null })), { text: "—", color: "var(--muted)" });
  assert.deepEqual(
    rightsBadge(base({ rights: [{ op: "read", ok: true, detail: "" }, { op: "write", ok: true, detail: "" }] })),
    { text: "✓ 2/2 ops", color: "#15803d" }
  );
  // A missing REQUIRED op fails; a missing OPTIONAL rides as a "+N optional" note, not a failure.
  assert.deepEqual(
    rightsBadge(base({ rights: [{ op: "read", ok: false, detail: "" }, { op: "opt", ok: false, detail: "", optional: true }] })),
    { text: "✗ missing 1 +1 optional", color: "#b91c1c" }
  );
  // Surplus (over-permissioned) rows show as Extra Access beside a still-green verified badge.
  assert.deepEqual(
    rightsBadge(base({ rights: [{ op: "read", ok: true, detail: "" }, { op: "extra", ok: false, detail: "", surplus: true, optional: true, escalation: true }] })),
    { text: "✓ 1/1 ops · Extra Access: 1 (1 risky)", color: "#15803d" }
  );
});

test("stageDetail surfaces the failing stage's message, else a status fallback", () => {
  assert.equal(stageDetail(base({ fieldsOk: false, fieldsDetail: "missing password" })), "missing password");
  assert.equal(stageDetail(base({ accessOk: false, accessDetail: "vault denied" })), "vault denied");
  assert.equal(stageDetail(base({ status: "ok", detail: "read 5 users" })), "read 5 users");
  assert.equal(stageDetail(base({ status: "pending" })), "waiting for a runner to claim it…");
  assert.equal(stageDetail(base({ status: "running" })), "testing…");
});

test("hasRights is true only when per-operation rows exist", () => {
  assert.equal(hasRights(base({ rights: null })), false);
  assert.equal(hasRights(base({ rights: [] })), false);
  assert.equal(hasRights(base({ rights: [{ op: "read", ok: true, detail: "" }] })), true);
});
