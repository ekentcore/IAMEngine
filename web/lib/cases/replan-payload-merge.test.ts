import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOperatorEdits } from "./replan-service";

// Bug: replanCase used to wholesale-replace payload with the freshly re-pulled ServiceNow intake,
// silently erasing any field the operator hand-edited via PATCH /api/cases/:id/fields (which stamps
// payload.fieldSource[k] = "operator") — e.g. saving "Additional groups" (extraGroups, FR #30) on an
// SN-sourced case would no-op and blank the input on the next re-plan. mergeOperatorEdits is the fix:
// overlay operator-sourced keys from the persisted payload onto the fresh intake before planning.

test("mergeOperatorEdits keeps an operator-added key the fresh intake doesn't have", () => {
  const fresh = { userPrincipalName: "jane@acme.com", department: "Sales" };
  const persisted = {
    userPrincipalName: "jane@acme.com",
    department: "Sales",
    extraGroups: "GIS Users, Finance Share",
    fieldSource: { extraGroups: "operator" },
  };
  const merged = mergeOperatorEdits(fresh, persisted);
  assert.equal(merged.extraGroups, "GIS Users, Finance Share");
});

test("mergeOperatorEdits takes every non-operator key from the fresh intake (SN stays source of truth)", () => {
  const fresh = { userPrincipalName: "jane@acme.com", department: "Marketing" }; // SN moved her
  const persisted = {
    userPrincipalName: "jane@acme.com",
    department: "Sales", // stale — not operator-owned
    extraGroups: "GIS Users",
    fieldSource: { extraGroups: "operator" },
  };
  const merged = mergeOperatorEdits(fresh, persisted);
  assert.equal(merged.department, "Marketing"); // fresh SN value wins
  assert.equal(merged.extraGroups, "GIS Users"); // operator key preserved
});

test("mergeOperatorEdits: operator value wins even when SN now ALSO supplies that key", () => {
  const fresh = { displayName: "Bill Smith" }; // SN's derived name
  const persisted = {
    displayName: "Bill Smith Jr.", // operator hand-corrected it
    fieldSource: { displayName: "operator" },
  };
  const merged = mergeOperatorEdits(fresh, persisted);
  assert.equal(merged.displayName, "Bill Smith Jr.");
});

test("mergeOperatorEdits preserves the fieldSource bookkeeping itself so provenance survives", () => {
  const fresh = { userPrincipalName: "jane@acme.com" };
  const persisted = {
    userPrincipalName: "jane@acme.com",
    extraGroups: "GIS Users",
    fieldSource: { extraGroups: "operator" },
  };
  const merged = mergeOperatorEdits(fresh, persisted);
  assert.deepEqual(merged.fieldSource, { extraGroups: "operator" });
});

test("mergeOperatorEdits is a no-op passthrough when nothing is operator-sourced", () => {
  const fresh = { userPrincipalName: "jane@acme.com", department: "Sales" };
  const persisted = { userPrincipalName: "jane@acme.com", department: "Old Sales" };
  const merged = mergeOperatorEdits(fresh, persisted);
  assert.deepEqual(merged, fresh);
});

test("mergeOperatorEdits ignores an operator key that vanished from the persisted payload (defensive)", () => {
  const fresh = { userPrincipalName: "jane@acme.com" };
  const persisted = { userPrincipalName: "jane@acme.com", fieldSource: { extraGroups: "operator" } }; // extraGroups key itself missing
  const merged = mergeOperatorEdits(fresh, persisted);
  assert.equal("extraGroups" in merged, false);
});
