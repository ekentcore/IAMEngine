import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { assembleProfile } from "./assemble.js";
import { makeValidator, formatErrors } from "./validate.js";
import type { IR } from "./ir.js";

const SCHEMA = fileURLToPath(new URL("../../../../profiles/_schema.json", import.meta.url));
const validate = makeValidator(SCHEMA);

function ir(over: Partial<IR> = {}): IR {
  return {
    irVersion: "1.0",
    client: { leaf: "Acme Holdings", path: "Acme Holdings", suggestedId: "acme-holdings", family: null, primaryDomain: "acme.com" },
    kb: { onboard: "KB1", offboard: "KB2" },
    actions: ["onboarding", "offboarding"],
    backboneHint: "ad-synced",
    detected: [
      { systemKey: "servicenow", action: "onboarding", section: "ServiceNow", confidence: 0.9, mode: "api", signals: { when: "always" } },
      { systemKey: "m365", action: "onboarding", section: "Microsoft 365", confidence: 0.9, mode: "api", signals: { when: "always", licenses: ["Microsoft 365 E3"] } },
      { systemKey: "active-directory", action: "onboarding", section: "Domain", confidence: 0.9, mode: "api", signals: { when: "always", ou: "Acme Users", guardrails: ["do-not-move-ou"] } },
      { systemKey: "m365", action: "offboarding", section: "365 Admin", confidence: 0.8, mode: "api", signals: { when: "always", captureEvidence: true } },
    ],
    unmodeled: [{ section: "Duo", action: "onboarding", guess: "Duo (MFA)" }],
    warnings: [],
    ...over,
  };
}

test("assembled profile validates against the real v2 schema", () => {
  const { profile } = assembleProfile(ir());
  const ok = validate(profile);
  assert.ok(ok, "schema errors: " + formatErrors(validate).join("; "));
});

test("carries backbone, directorySync, and m365 licenses", () => {
  const { profile } = assembleProfile(ir());
  assert.equal(profile.identity.backbone, "ad-synced");
  assert.ok(profile.identity.directorySync, "ad-synced should get directorySync");
  const m365 = profile.systems.find((s) => s.key === "m365")!;
  assert.deepEqual(m365.onboard?.config?.licenses, ["Microsoft 365 E3"]);
});

test("merges onboarding+offboarding lanes into one system entry", () => {
  const { profile } = assembleProfile(ir());
  const m365 = profile.systems.find((s) => s.key === "m365")!;
  assert.ok(m365.onboard && m365.offboard, "m365 should have both lanes");
  assert.equal(m365.offboard?.captureEvidence, true);
});

test("AD guardrails and OU survive into the onboard lane", () => {
  const { profile } = assembleProfile(ir());
  const ad = profile.systems.find((s) => s.key === "active-directory")!;
  assert.deepEqual(ad.onboard?.guardrails, ["do-not-move-ou"]);
  assert.equal(ad.onboard?.config?.ou, "Acme Users");
});

test("missing backbone defaults to entra and lowers confidence", () => {
  const { profile, meta } = assembleProfile(ir({ backboneHint: null }));
  assert.equal(profile.identity.backbone, "entra");
  assert.equal(meta.backboneDefaulted, true);
  assert.ok(meta.confidence < 0.9);
});

test("dependsOn never references a system not present in the profile", () => {
  // only active-directory detected (no servicenow) — must not depend on a missing system.
  const onlyAd = ir({
    detected: [{ systemKey: "active-directory", action: "onboarding", section: "Domain", confidence: 0.9, mode: "api", signals: { when: "always" } }],
  });
  const { profile } = assembleProfile(onlyAd);
  const present = new Set(profile.systems.map((s) => s.key));
  for (const s of profile.systems) {
    for (const dep of s.dependsOn ?? []) {
      assert.ok(present.has(dep), `${s.key} depends on missing ${dep}`);
    }
  }
});

test("out-of-enum guardrails are filtered out (stays schema-valid)", () => {
  const bad = ir({
    detected: [
      { systemKey: "servicenow", action: "onboarding", section: "ServiceNow", confidence: 0.9, mode: "api", signals: { when: "always" } },
      { systemKey: "active-directory", action: "offboarding", section: "Domain", confidence: 0.9, mode: "api", signals: { when: "always", guardrails: ["do-not-move-ou", "no-such-guardrail"] } },
    ],
  });
  const { profile } = assembleProfile(bad);
  assert.ok(validate(profile), "schema errors: " + formatErrors(validate).join("; "));
  const ad = profile.systems.find((s) => s.key === "active-directory")!;
  assert.deepEqual(ad.offboard?.guardrails, ["do-not-move-ou"]);
});

test("out-of-enum 'when' falls back to always (stays schema-valid)", () => {
  const bad = ir({
    detected: [{ systemKey: "servicenow", action: "onboarding", section: "ServiceNow", confidence: 0.9, mode: "api", signals: { when: "conditional" } }],
  });
  const { profile } = assembleProfile(bad);
  assert.ok(validate(profile), "schema errors: " + formatErrors(validate).join("; "));
  assert.equal(profile.systems[0].onboard?.when, "always");
});

test("missing primary domain still produces a schema-valid profile", () => {
  const { profile, meta } = assembleProfile(ir({ client: { ...ir().client, primaryDomain: null } }));
  assert.ok(validate(profile), "schema errors: " + formatErrors(validate).join("; "));
  assert.equal(meta.primaryDomainMissing, true);
});
