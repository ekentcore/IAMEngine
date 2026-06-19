import { test } from "node:test";
import assert from "node:assert/strict";
import { planCase } from "./orchestrator";
import type { ClientSystem } from "@prisma/client";

function sys(over: Partial<ClientSystem>): ClientSystem {
  return {
    id: "id", clientId: "c", systemKey: "m365", mode: "api",
    onboardWhen: "always", offboardWhen: "always",
    dependsOn: [], requiresApproval: false, captureEvidence: false,
    secretNames: [], config: null,
    ...over,
  } as unknown as ClientSystem;
}

test("always lanes included, never lanes excluded", () => {
  const systems = [sys({ systemKey: "servicenow" }), sys({ systemKey: "x", onboardWhen: "never" })];
  const keys = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.deepEqual(keys, ["servicenow"]);
});

test("on-request 'teams' is gated by the phone-line signal", () => {
  const systems = [sys({ systemKey: "servicenow" }), sys({ systemKey: "teams", onboardWhen: "on_request" })];
  assert.ok(planCase(systems, "onboard", { officeLineRequired: true }).some((j) => j.systemKey === "teams"));
  assert.equal(planCase(systems, "onboard", {}).some((j) => j.systemKey === "teams"), false);
});

test("on-request honors a config.requestKey override", () => {
  const systems = [sys({ systemKey: "adobe", onboardWhen: "on_request", config: { requestKey: "needsAdobe" } })];
  assert.equal(planCase(systems, "onboard", { needsAdobe: true }).length, 1);
  assert.equal(planCase(systems, "onboard", {}).length, 0);
});

test("on-request falls back to a payload flag named after the system (manual cases)", () => {
  const systems = [sys({ systemKey: "zoom", onboardWhen: "on_request" })];
  assert.equal(planCase(systems, "onboard", { zoom: true }).length, 1);
  assert.equal(planCase(systems, "onboard", {}).length, 0);
});

test("planned job config is the lane's config, not the whole blob", () => {
  const cfg = { onboard: { licenses: ["E3"] }, offboard: { blockSignIn: true }, dependsOn: {} };
  assert.deepEqual(planCase([sys({ config: cfg })], "onboard", {})[0].config, { licenses: ["E3"] });
  assert.deepEqual(planCase([sys({ config: cfg })], "offboard", {})[0].config, { blockSignIn: true });
});

test("requiresApproval/captureEvidence resolve per-lane (no cross-lane bleed)", () => {
  const cfg = { onboard: null, offboard: null, requiresApproval: { offboard: true }, captureEvidence: { offboard: true } };
  // column is the collapsed OR (true) — must NOT leak onto the onboard lane.
  const on = planCase([sys({ config: cfg, requiresApproval: true, captureEvidence: true })], "onboard", {})[0];
  assert.equal(on.requiresApproval, false);
  assert.equal(on.captureEvidence, false);
  const off = planCase([sys({ config: cfg, requiresApproval: true, captureEvidence: true })], "offboard", {})[0];
  assert.equal(off.requiresApproval, true);
  assert.equal(off.captureEvidence, true);
});

test("legacy config without per-lane flags falls back to the column", () => {
  const j = planCase([sys({ config: { onboard: {}, offboard: {} }, requiresApproval: true })], "onboard", {})[0];
  assert.equal(j.requiresApproval, true);
});

test("topological order honors dependsOn", () => {
  const systems = [sys({ systemKey: "m365", dependsOn: ["servicenow"] }), sys({ systemKey: "servicenow" })];
  const order = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.ok(order.indexOf("servicenow") < order.indexOf("m365"));
});

test("case-resolution always runs last: implicit dependency on every other system", () => {
  const systems = [
    sys({ systemKey: "case-resolution" }), // declared FIRST, no deps — would dispatch first under naive DAG
    sys({ systemKey: "m365" }),
    sys({ systemKey: "mimecast", dependsOn: ["m365"] }),
  ];
  const plan = planCase(systems, "onboard", {});
  const resolution = plan.find((j) => j.systemKey === "case-resolution")!;
  assert.equal(plan[plan.length - 1].systemKey, "case-resolution");
  assert.deepEqual([...resolution.dependsOn].sort(), ["m365", "mimecast"]);
});

test("a manual step never carries requiresApproval (approval gates only auto-running API steps)", () => {
  // sentinelone as a MANUAL checklist item with requiresApproval set: the human doing it IS the
  // approval, so it must not put the case in "needs approval".
  const manual = planCase([sys({ systemKey: "sentinelone", mode: "manual", requiresApproval: true })], "offboard", {})[0];
  assert.equal(manual.requiresApproval, false);
  // the same system as an API step keeps its approval gate
  const api = planCase([sys({ systemKey: "sentinelone", mode: "api", requiresApproval: true })], "offboard", {})[0];
  assert.equal(api.requiresApproval, true);
});
