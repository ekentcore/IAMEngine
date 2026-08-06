import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePlannedConfigs } from "./plan-resolve";
import type { PlannedJob } from "../orchestrator";

const job = (config: unknown): PlannedJob => ({ systemKey: "active-directory", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config });

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

// FR #7: the intake names WHO gets access to the leaver's mailbox (provideMailboxAccessTo) —
// planned onto the exchange job as grantFullAccessTo. Previously captured and dropped.
test("offboard hands the case-requested mailbox delegate to the exchange job", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 1, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: { convertToShared: {} } };
  const out = resolvePlannedConfigs(client, { userToOffboard: "Matt Halski", provideMailboxAccessTo: "Peter Hegland" }, "offboard", [job({}), exchange]);
  const ex = out.find((j) => j.systemKey === "exchange")!.config as Record<string, unknown>;
  assert.equal(ex.grantFullAccessTo, "Peter Hegland");
  assert.deepEqual(ex.convertToShared, {}); // existing lane config preserved
  // the AD job is untouched
  assert.equal((out.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).grantFullAccessTo, undefined);
});

test("offboard delegate injection works for a v2.0 client (no personas/globals) and skips blanks", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: "Peter Hegland" }, "offboard", [exchange]);
  assert.equal((out[0].config as Record<string, unknown>).grantFullAccessTo, "Peter Hegland");
  const none = resolvePlannedConfigs({}, { provideMailboxAccessTo: "  " }, "offboard", [exchange]);
  assert.equal((none[0].config as Record<string, unknown>).grantFullAccessTo, undefined);
});

// FR #8: the same case-named delegate also gets the leaver's OneDrive (m365/entra lane), unless
// the client opted out with oneDriveDelegateAccess: false.
test("offboard delegate also lands on the m365 job as the OneDrive grant", () => {
  const m365: PlannedJob = { systemKey: "m365", sequence: 1, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: "Peter Hegland" }, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).oneDriveGrantAccessTo, "Peter Hegland");
  const optedOut: PlannedJob = { ...m365, config: { oneDriveDelegateAccess: false } };
  const none = resolvePlannedConfigs({}, { provideMailboxAccessTo: "Peter Hegland" }, "offboard", [optedOut]);
  assert.equal((none[0].config as Record<string, unknown>).oneDriveGrantAccessTo, undefined);
});

// FR #47: the intake captures the leaver's out-of-office message (u_out_of_office_message ->
// payload.oooMessage) and NOTHING read it — a codebase-wide search found the mapper writing it and no
// consumer at all. The Exchange executor has always implemented the destination
// (config.autoReply.message -> Set-MailboxAutoReplyConfiguration), so the gap was purely plan-time.
test("offboard hands the case's out-of-office message to the exchange job", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 1, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: { convertToShared: {} } };
  const out = resolvePlannedConfigs(client, { userToOffboard: "Matt Halski", oooMessage: "I have left Acme. Please contact support@acme.com." }, "offboard", [job({}), exchange]);
  const ex = out.find((j) => j.systemKey === "exchange")!.config as Record<string, unknown>;
  assert.deepEqual(ex.autoReply, { message: "I have left Acme. Please contact support@acme.com." });
  assert.deepEqual(ex.convertToShared, {}); // existing lane config preserved
  // only Exchange can set an out-of-office — the AD job must not carry it
  assert.equal((out.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).autoReply, undefined);
});

test("the ticket's out-of-office message overrides a profile-configured one", () => {
  // Consistent with the FR #87 ruling: what the ticket says wins over the client's standing default.
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: { autoReply: { message: "the client default" } } };
  const out = resolvePlannedConfigs({}, { oooMessage: "what the ticket asked for" }, "offboard", [exchange]);
  assert.deepEqual((out[0].config as Record<string, unknown>).autoReply, { message: "what the ticket asked for" });
});

test("no out-of-office on the ticket leaves the profile's own autoReply untouched", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: { autoReply: { message: "the client default" } } };
  for (const payload of [{}, { oooMessage: "" }, { oooMessage: "   " }, { oooMessage: null }]) {
    const out = resolvePlannedConfigs({}, payload, "offboard", [exchange]);
    assert.deepEqual((out[0].config as Record<string, unknown>).autoReply, { message: "the client default" }, `payload ${JSON.stringify(payload)}`);
  }
});

test("an out-of-office message is never injected on an ONBOARD", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { oooMessage: "I have left" }, "onboard", [exchange]);
  assert.equal((out[0].config as Record<string, unknown>).autoReply, undefined);
});
