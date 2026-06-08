import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePlannedConfigs } from "./plan-resolve";
import type { PlannedJob } from "../orchestrator";

const job = (config: unknown): PlannedJob => ({ systemKey: "active-directory", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, secretNames: [], config });

const client = {
  globals: { "active-directory": { groups: ["New-Hire-ALL"] } }, // onboard rules (should NOT leak to offboard)
  globalsOffboard: {
    "active-directory": {
      groups: ["Disabled-Users", { groups: ["Contractors-Off"], when: "employmentType == Contractor" }],
      ou: "OU=Disabled Users,DC=core,DC=tech",
      attributes: { description: "Offboarded" },
    },
  },
  personas: {},
};

test("offboard resolves globalsOffboard into removeGroups / moveToOu / offboardAttributes", () => {
  const out = resolvePlannedConfigs(client, { employmentType: "Contractor" }, "offboard", [job({ disable: true })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.deepEqual(cfg.removeGroups, ["Disabled-Users", "Contractors-Off"]); // conditional rule fired for a contractor
  assert.equal(cfg.moveToOu, "OU=Disabled Users,DC=core,DC=tech");
  assert.deepEqual(cfg.offboardAttributes, { description: "Offboarded" });
  assert.equal(cfg.disable, true); // the lane's own offboard config is preserved
});

test("offboard conditional group rule does NOT fire when the condition is false", () => {
  const out = resolvePlannedConfigs(client, { employmentType: "Full-Time" }, "offboard", [job({})]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.deepEqual(cfg.removeGroups, ["Disabled-Users"]); // Contractors-Off excluded
});

test("onboard is unchanged by offboard rules (no removeGroups leaks in)", () => {
  const out = resolvePlannedConfigs(client, {}, "onboard", [job({})]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.equal(cfg.removeGroups, undefined);
  assert.deepEqual(cfg.groups, ["New-Hire-ALL"]); // onboard globals applied
});
