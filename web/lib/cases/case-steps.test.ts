import { test } from "node:test";
import assert from "node:assert/strict";
import { stepRows, selectionToLists } from "./case-steps";

const systems = [
  { systemKey: "m365", onboardWhen: "always", offboardWhen: "always" },
  { systemKey: "zoom", onboardWhen: "on_request", offboardWhen: "on_request" },
  { systemKey: "adobe", onboardWhen: "on_request", offboardWhen: "always" },
  { systemKey: "entra", onboardWhen: "never", offboardWhen: "always" },
];
const base = { systems, action: "onboard" as const, natural: new Set(["m365"]), requested: [], skipped: [], intakeSkipped: new Set<string>(), jobs: [] };

test("one row per system with a step in this lane; 'never' lanes are not offered", () => {
  assert.deepEqual(stepRows(base).map((r) => r.systemKey), ["adobe", "m365", "zoom"]);
});

test("runs = natural + requested - skipped", () => {
  const rows = stepRows({ ...base, requested: ["zoom"], skipped: ["m365"] });
  const runs = Object.fromEntries(rows.map((r) => [r.systemKey, r.runs]));
  assert.deepEqual(runs, { adobe: false, m365: false, zoom: true });
});

test("a step that already ran, or one an intake rule skips, is locked", () => {
  const rows = stepRows({ ...base, jobs: [{ systemKey: "m365", status: "succeeded" }], intakeSkipped: new Set(["zoom"]) });
  assert.equal(rows.find((r) => r.systemKey === "m365")!.locked, "already ran on this case");
  assert.equal(rows.find((r) => r.systemKey === "zoom")!.locked, "skipped by an intake rule for this requester");
  assert.equal(rows.find((r) => r.systemKey === "zoom")!.runs, false);
  assert.equal(rows.find((r) => r.systemKey === "adobe")!.locked, null);
});

test("only differences from the natural plan are stored", () => {
  const rows = stepRows(base);
  // want zoom on (requested), m365 off (skipped), adobe untouched (stays off, not stored)
  assert.deepEqual(selectionToLists(rows, new Set(["zoom"])), { requestedSystems: ["zoom"], skippedSystems: ["m365"] });
  // the natural selection stores nothing
  assert.deepEqual(selectionToLists(rows, new Set(["m365"])), { requestedSystems: [], skippedSystems: [] });
});

test("a key with no step in this lane is never stored", () => {
  assert.deepEqual(selectionToLists(stepRows(base), new Set(["m365", "entra", "nonsense"])), { requestedSystems: [], skippedSystems: [] });
});
