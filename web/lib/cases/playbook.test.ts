import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaybook, renderPlaybookMarkdown, type BuildPlaybookInput } from "./playbook";

function input(overrides: Partial<BuildPlaybookInput> = {}): BuildPlaybookInput {
  return {
    caseId: "case-1",
    caseNumber: "UM0028740",
    subject: "ONB - Jane Doe",
    action: "onboard",
    client: { name: "Acme", slug: "acme", primaryDomain: "acme.com", identity: { usernamePatterns: ["{first}.{last}@{domain}"] } },
    payload: { userPrincipalName: "jane.doe@acme.com", firstName: "Jane", lastName: "Doe", productLicenses: ["Microsoft 365 E3"] },
    jobs: [
      { systemKey: "m365", sequence: 0, mode: "api", request: { config: { licenses: ["Microsoft 365 E3"] }, secretNames: ["m365-admin"], requiresApproval: false } },
      { systemKey: "directory-sync", sequence: 1, mode: "api", request: { config: {} } },
      { systemKey: "welcome-letter", sequence: 2, mode: "manual", request: {} },
    ],
    systems: [
      { systemKey: "m365", dependsOn: [], config: {} },
      { systemKey: "directory-sync", dependsOn: ["m365"], config: {} },
      { systemKey: "welcome-letter", dependsOn: [], config: {} },
    ],
    names: new Map([["m365", "Microsoft 365"], ["directory-sync", "Directory Sync"], ["welcome-letter", "Welcome letter"]]),
    manualText: new Map([["welcome-letter", "Send the welcome letter to the new hire"]]),
    ...overrides,
  };
}

test("buildPlaybook emits ordered steps with resolved scripts + dependency order", () => {
  const pb = buildPlaybook(input());
  assert.equal(pb.steps.length, 3);
  assert.equal(pb.user, "jane.doe@acme.com");

  const m365 = pb.steps[0];
  assert.equal(m365.seq, 1);
  assert.equal(m365.systemName, "Microsoft 365");
  assert.match(m365.willRun ?? "", /jane\.doe@acme\.com/); // resolved inline
  assert.deepEqual(m365.secretNames, ["m365-admin"]);
  assert.ok(m365.validates.length > 0);

  const sync = pb.steps[1];
  assert.deepEqual(sync.dependsOn, ["m365"]); // lane/system dep, filtered to present systems
});

test("buildPlaybook treats manual steps as checklist items (no script)", () => {
  const pb = buildPlaybook(input());
  const manual = pb.steps[2];
  assert.equal(manual.willRun, null);
  assert.equal(manual.manualText, "Send the welcome letter to the new hire");
});

test("renderPlaybookMarkdown produces a reviewable doc", () => {
  const md = renderPlaybookMarkdown(buildPlaybook(input()));
  assert.match(md, /# Playbook \(dry run\)/);
  assert.match(md, /Action: onboard/);
  assert.match(md, /```powershell/);
  assert.match(md, /Validates after running:/);
});
