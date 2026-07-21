import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIntakeRule } from "../profiles/intake-rules";
import { planCase } from "../orchestrator";
import { deriveIdentity } from "../servicenow/intake-mapper";
import type { ClientSystem } from "@prisma/client";

// This test exercises the exact composition planning-service performs (match → force domain →
// derive identity → planCase with skipSystems), without a DB.
function sys(systemKey: string): ClientSystem {
  return {
    id: `id-${systemKey}`, clientId: "c1", systemKey, mode: "api",
    onboardWhen: "always", offboardWhen: "never", dependsOn: [],
    requiresApproval: false, captureEvidence: false, secretNames: [], config: null,
  } as unknown as ClientSystem;
}
const systems = [sys("active-directory"), sys("directory-sync"), sys("entra"), sys("m365"), sys("exchange")];
const intakeRules = {
  rules: [{
    id: "shawmut-infinite", label: "Shawmut Infinite (cloud-only)",
    match: { contacts: [{ sysId: "7750e1e447bdf29c3c5e88f4116d4393", name: "Angie Shropshire" }] },
    effects: { skipSystems: ["active-directory", "directory-sync"], forceDomain: "shawmutinfinite.com" },
  }],
};

function compose(payload: Record<string, unknown>, defaultDomain: string) {
  const rule = matchIntakeRule(intakeRules, payload);
  const domain = rule?.forceDomain ?? defaultDomain;
  let p = deriveIdentity({ ...payload }, { usernamePatterns: ["{first}.{last}"], primaryDomain: domain });
  if (rule) p = { ...p, __intakeRule: { id: rule.id, label: rule.label } };
  const planned = planCase(systems, "onboard", p, undefined, undefined, undefined, rule?.skipSystems);
  return { planned, payload: p, rule };
}

test("matched requester → cloud-only plan on forced domain", () => {
  const { planned, payload } = compose(
    { firstName: "Kate", lastName: "Doe", requestedByContactSysId: "7750e1e447bdf29c3c5e88f4116d4393" },
    "shawmutcorporation.com",
  );
  const keys = planned.map((j) => j.systemKey);
  assert.ok(!keys.includes("active-directory"));
  assert.ok(!keys.includes("directory-sync"));
  assert.ok(!keys.includes("ad-email-writeback"));
  assert.ok(keys.includes("m365"));
  assert.match(String(payload.userPrincipalName), /@shawmutinfinite\.com$/);
  assert.match(String(payload.workEmail), /@shawmutinfinite\.com$/);
  assert.equal((payload.__intakeRule as { id: string }).id, "shawmut-infinite");
});

test("other requester → normal AD-synced plan on default domain", () => {
  const { planned, payload, rule } = compose(
    { firstName: "Bob", lastName: "Roe", requestedByContactSysId: "0000000000000000000000000000dead" },
    "shawmutcorporation.com",
  );
  assert.equal(rule, null);
  assert.ok(planned.map((j) => j.systemKey).includes("active-directory"));
  assert.match(String(payload.userPrincipalName), /@shawmutcorporation\.com$/);
  assert.equal(payload.__intakeRule, undefined);
});
