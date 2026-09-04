import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePlannedConfigs, caseForwardingAddress } from "./plan-resolve";
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

// FR #84: FR #7 built the delegate grant for exactly ONE person — a single string on the payload and a
// single string on the job config. Multiple delegates are now supported end to end.
//
// WIRE COMPATIBILITY is deliberate: one delegate still travels as a plain STRING, byte-identical to
// what shipped before, so a runner that hasn't picked up the new module yet behaves exactly as it does
// today. The array shape only appears when there is genuinely more than one name — i.e. the new
// behaviour engages only when the new feature is actually used.
test("a single delegate still travels as a plain string (old runners unaffected)", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: "Peter Hegland" }, "offboard", [exchange]);
  assert.equal((out[0].config as Record<string, unknown>).grantFullAccessTo, "Peter Hegland");
});

test("several delegates travel as an array, in ticket order", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: ["Peter Hegland", "Dev Gani"] }, "offboard", [exchange]);
  assert.deepEqual((out[0].config as Record<string, unknown>).grantFullAccessTo, ["Peter Hegland", "Dev Gani"]);
});

test("a one-element array collapses back to a string — the wire shape follows the COUNT, not the input type", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: ["Peter Hegland"] }, "offboard", [exchange]);
  assert.equal((out[0].config as Record<string, unknown>).grantFullAccessTo, "Peter Hegland");
});

test("blanks and duplicates are dropped before anything is planned", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  // A duplicate would make the runner grant the same person twice and log it twice; "" and "  " are
  // what an emptied ServiceNow row looks like.
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: ["Peter Hegland", "  ", "peter hegland", "", "Dev Gani"] }, "offboard", [exchange]);
  assert.deepEqual((out[0].config as Record<string, unknown>).grantFullAccessTo, ["Peter Hegland", "Dev Gani"]);
});

test("an all-blank delegate list plans no grant at all", () => {
  const exchange: PlannedJob = { systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  for (const payload of [{ provideMailboxAccessTo: [] }, { provideMailboxAccessTo: ["", "   "] }]) {
    const out = resolvePlannedConfigs({}, payload, "offboard", [exchange]);
    assert.equal((out[0].config as Record<string, unknown>).grantFullAccessTo, undefined, JSON.stringify(payload));
  }
});

test("every delegate also reaches the OneDrive grant on the m365 job", () => {
  const m365: PlannedJob = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
  const out = resolvePlannedConfigs({}, { provideMailboxAccessTo: ["Peter Hegland", "Dev Gani"] }, "offboard", [m365]);
  assert.deepEqual((out[0].config as Record<string, unknown>).oneDriveGrantAccessTo, ["Peter Hegland", "Dev Gani"]);
});

const exch = (config: unknown): PlannedJob => ({ systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config });
const bare = { globals: {}, globalsOffboard: {}, personas: {} };

test("caseForwardingAddress: strips the sys_id the intake appends for display", () => {
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb6d847383d1418d7d65c346d4354)" }), "lyao@aleto.co");
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "  lyao@aleto.co  " }), "lyao@aleto.co");
});

test("caseForwardingAddress: an address alone is NOT a request - mailForwarded gates it", () => {
  // UM0030515 and UM0030178 are real cases shaped exactly like this. Forwarding a leaver's mail
  // against an explicit "no" is worse than the bug this fixes.
  assert.equal(caseForwardingAddress({ mailForwarded: false, forwardEmailTo: "brandon@drivecapital.com (af605134db3b15d0887192ccd3961959)" }), null);
  assert.equal(caseForwardingAddress({ forwardEmailTo: "brandon@drivecapital.com" }), null);
});

test("caseForwardingAddress: a display name or a bare sys_id is not an SMTP address", () => {
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "Andrew Cohen (sysid123)" }), null);
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "sysidonly" }), null);
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "" }), null);
  assert.equal(caseForwardingAddress({ mailForwarded: true }), null);
});

test("offboard plans the case-requested forwarding onto the exchange step (FR #0000097)", () => {
  const out = resolvePlannedConfigs(bare, { mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb)" }, "offboard", [exch({ convertToShared: true })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.deepEqual(cfg.forwarding, { address: "lyao@aleto.co" });
  assert.equal(cfg.convertToShared, true); // the rest of the config survives
});

test("offboard forwarding keeps a profile-configured keepCopy and only sets the address", () => {
  const out = resolvePlannedConfigs(bare, { mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb)" }, "offboard", [exch({ forwarding: { keepCopy: true } })]);
  assert.deepEqual((out[0].config as Record<string, unknown>).forwarding, { keepCopy: true, address: "lyao@aleto.co" });
});

test("offboard leaves forwarding alone when the ticket did not ask for it", () => {
  const out = resolvePlannedConfigs(bare, { mailForwarded: false, forwardEmailTo: "x@y.com (id)" }, "offboard", [exch({ convertToShared: true })]);
  assert.equal((out[0].config as Record<string, unknown>).forwarding, undefined);
});

test("offboard forwarding is exchange-only - the m365 lane is untouched", () => {
  const m365 = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} } as PlannedJob;
  const out = resolvePlannedConfigs(bare, { mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb)" }, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).forwarding, undefined);
});

const spanning = (config: unknown, intent: "disable" | "destructive" | null = "destructive"): PlannedJob =>
  ({ systemKey: "spanning", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent, secretNames: [], dependsOn: [], config } as PlannedJob);

test("a DESTRUCTIVE spanning offboard drops the licence instead of converting to Archive (FR #0000095)", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, true);
});

test("a non-destructive spanning offboard still converts to Archive", () => {
  // For these clients the Archive conversion IS the intent. Unassigning their seats could delete
  // backups nobody agreed to lose.
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({}, "disable")]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, undefined);
});

test("an explicitly configured swapLicense wins over the destructive default", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({ swapLicense: { from: "Standard", to: "Archive" } })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.equal(cfg.removeLicense, undefined);           // the client configured a swap deliberately
  assert.deepEqual(cfg.swapLicense, { from: "Standard", to: "Archive" });
});

test("an already-set removeLicense is left exactly as it is", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({ removeLicense: false })]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, false);
});

test("the rest of the spanning config survives the injection", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({ afterMailboxConvertAndLicenseRemoval: true })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.equal(cfg.afterMailboxConvertAndLicenseRemoval, true);
  assert.equal(cfg.removeLicense, true);
});

test("a destructive step on ANOTHER system is not given a spanning licence flag", () => {
  const m365 = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: "destructive", secretNames: [], dependsOn: [], config: {} } as PlannedJob;
  const out = resolvePlannedConfigs(bare, {}, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, undefined);
});

test("a destructive spanning step is not touched on an ONBOARD", () => {
  const out = resolvePlannedConfigs(bare, {}, "onboard", [spanning({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, undefined);
});

const ad = (config: unknown, captureEvidence = false): PlannedJob =>
  ({ systemKey: "active-directory", sequence: 0, mode: "api", requiresApproval: false, captureEvidence,
     intent: "disable", secretNames: [], dependsOn: [], config } as PlannedJob);

test("an AD offboard with no group policy defaults to removing all groups (FR #0000109)", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, true);
});

test("the default ALSO forces an evidence snapshot - never strip what we didn't record", () => {
  // 16 of 44 AD clients captured no evidence on offboard. Stripping every group without recording
  // them first is a one-way door: nobody knows what to re-add.
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({})]);
  assert.equal(out[0].captureEvidence, true);
});

test("an explicit removeAllGroups:false is a deliberate opt-out and is honoured", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({ removeAllGroups: false })]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, false);
  assert.equal(out[0].captureEvidence, false); // no default fired, so nothing was forced
});

test("a client with named removeGroups rules keeps them and gets no blanket default", () => {
  const client = { globals: {}, personas: {},
    globalsOffboard: { "active-directory": { groups: ["Contractors"] } } };
  const out = resolvePlannedConfigs(client, {}, "offboard", [ad({})]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.deepEqual(cfg.removeGroups, ["Contractors"]);
  assert.equal(cfg.removeAllGroups, undefined);
});

test("a client already capturing evidence is left exactly as it is", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({}, true)]);
  assert.equal(out[0].captureEvidence, true);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, true);
});

test("the AD group default is AD-only - no other lane gets a group flag", () => {
  const m365 = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false,
                 captureEvidence: false, intent: "disable", secretNames: [], dependsOn: [], config: {} } as PlannedJob;
  const out = resolvePlannedConfigs(bare, {}, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, undefined);
});

test("no AD group default is injected on an ONBOARD", () => {
  const out = resolvePlannedConfigs(bare, {}, "onboard", [ad({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, undefined);
});
