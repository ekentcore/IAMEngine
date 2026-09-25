import { test } from "node:test";
import assert from "node:assert/strict";
import { withGoogleOu, checkGoogleOu } from "./google-ou";
import type { PlannedJob } from "../orchestrator";

const job = (systemKey: string, config: Record<string, unknown> | null = null) =>
  ({ systemKey, sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config }) as unknown as PlannedJob;

test("an onboard pick sets the Google job's ou, over the client default", () => {
  const out = withGoogleOu([job("google-workspace", { ou: "/Active Users", groups: ["g"] }), job("m365")], { googleOu: "/Active Users/Sales" }, "onboard");
  assert.deepEqual(out[0].config, { ou: "/Active Users/Sales", groups: ["g"] });
  assert.equal(out[1].config, null);
});

test("an offboard pick sets inactiveOu, and each lane only reads its own field", () => {
  const payload = { googleOu: "/Active Users/Sales", googleInactiveOu: "/Former Staff" };
  assert.deepEqual(withGoogleOu([job("google-workspace")], payload, "offboard")[0].config, { inactiveOu: "/Former Staff" });
});

test("no pick, or an invalid one, leaves the client's setting alone", () => {
  const jobs = [job("google-workspace", { ou: "/Active Users" })];
  assert.deepEqual(withGoogleOu(jobs, {}, "onboard")[0].config, { ou: "/Active Users" });
  assert.deepEqual(withGoogleOu(jobs, { googleOu: "/" }, "onboard")[0].config, { ou: "/Active Users" });
  assert.deepEqual(withGoogleOu(jobs, { googleOu: "Sales" }, "onboard")[0].config, { ou: "/Active Users" });
});

test("checkGoogleOu refuses root, relative paths and empty segments; trims a trailing slash", () => {
  assert.deepEqual(checkGoogleOu(" /Active Users/Sales/ "), { ok: true, ou: "/Active Users/Sales" });
  assert.equal(checkGoogleOu("/").ok, false);
  assert.equal(checkGoogleOu("Active Users").ok, false);
  assert.equal(checkGoogleOu("/Active Users//Sales").ok, false);
  assert.equal(checkGoogleOu("  ").ok, false);
});
