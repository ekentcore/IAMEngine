import { test } from "node:test";
import assert from "node:assert/strict";
import { stampFieldEditedAt } from "./field-edited-at";

test("stamps each edited key with the edit time and keeps earlier stamps", () => {
  const payload: Record<string, unknown> = { fieldEditedAt: { department: "2026-01-01T00:00:00.000Z" } };
  stampFieldEditedAt(payload, ["userPrincipalName"], new Date("2026-09-23T12:00:00Z"));
  assert.deepEqual(payload.fieldEditedAt, { department: "2026-01-01T00:00:00.000Z", userPrincipalName: "2026-09-23T12:00:00.000Z" });
});

test("no keys, no change", () => {
  const payload: Record<string, unknown> = {};
  stampFieldEditedAt(payload, [], new Date());
  assert.equal(payload.fieldEditedAt, undefined);
});
