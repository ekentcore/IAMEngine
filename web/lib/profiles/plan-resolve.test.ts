import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePlannedConfigs } from "./plan-resolve";
import type { PlannedJob } from "../orchestrator";

// End-to-end of step 1: a real onboard PAYLOAD (intake + derived identity) → the planner's
// resolved per-job config, using the authored coretelligent profile.
const profile = JSON.parse(readFileSync(join(process.cwd(), "..", "profiles", "coretelligent.json"), "utf8"));
const client = { personas: profile.personas, globals: profile.globals, locations: profile.locations };
const sys = (k: string) => profile.systems.find((s: { key: string }) => s.key === k);

function job(systemKey: string, config: unknown): PlannedJob {
  return { systemKey, sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config };
}

const payload = {
  firstName: "John", lastName: "Doe", jobTitle: "Senior Client Support Engineer",
  department: "Field Services", officeLocation: "CA", employmentType: "Full-Time",
  startDate: "06/15/26", managerName: "CN=Jane Boss,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local",
  samAccountName: "jdoe", userPrincipalName: "jdoe@core.tech", primaryDomain: "core.tech",
};

test("onboard payload → AD job gets the resolved OU, group union, and attributes", () => {
  const planned = [job("active-directory", sys("active-directory").onboard.config), job("servicenow", sys("servicenow").onboard.config)];
  const resolved = resolvePlannedConfigs(client, payload, "onboard", planned);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;

  assert.equal(ad.ou, "OU=CA,OU=Field Services,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local");
  assert.deepEqual(ad.groups, [
    "Egnyte-CS-CORE", "Centrify - Egnyte Power Users", "RDS-Users", "VPN-Split", "Core-ALL",
    "DEPT-Field", "ExchStatusReport", "Notifications", "TechStaff", "SSO - Zoom Pro Users",
  ]);
  const a = ad.attributes as Record<string, string>;
  assert.equal(a.company, "Coretelligent");
  assert.equal(a.department, "Field Services");
  assert.equal(a.title, "Senior Client Support Engineer");
  assert.equal(a.c, "US");
  assert.equal(a.employeeType, "Full-Time");
  assert.equal(a.manager, payload.managerName);
  // own lane config preserved (enabled: true) alongside the resolved persona/global fragments
  assert.equal(ad.enabled, true);

  // servicenow has no persona/global fragment → its lane config is untouched
  const snow = resolved.find((j) => j.systemKey === "servicenow")!.config as Record<string, unknown>;
  assert.deepEqual(snow.requiredFields, sys("servicenow").onboard.config.requiredFields);
});

test("offboard does not apply persona/role resolution", () => {
  const planned = [job("active-directory", { disable: true })];
  const resolved = resolvePlannedConfigs(client, payload, "offboard", planned);
  assert.deepEqual((resolved[0].config as Record<string, unknown>), { disable: true });
});

test("a v2.0 client (no personas/globals) passes through unchanged", () => {
  const planned = [job("m365", { licenses: ["E3"] })];
  const resolved = resolvePlannedConfigs({ personas: null, globals: null, locations: null }, payload, "onboard", planned);
  assert.deepEqual((resolved[0].config as Record<string, unknown>), { licenses: ["E3"] });
});

test("mirror directive → mirrorFromUser injected onto the directory job (v2.1)", () => {
  const planned = [job("active-directory", sys("active-directory").onboard.config), job("servicenow", { x: 1 })];
  const resolved = resolvePlannedConfigs(client, { ...payload, mirrorPermissionsFromUser: "Christine Holleran" }, "onboard", planned);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.equal(ad.mirrorFromUser, "Christine Holleran");
  assert.ok(Array.isArray(ad.groups)); // persona/global resolution still applied
  // non-directory systems don't get a mirror directive
  const snow = resolved.find((j) => j.systemKey === "servicenow")!.config as Record<string, unknown>;
  assert.equal("mirrorFromUser" in snow, false);
});

test("mirror injected even for a v2.0 client (no personas/globals)", () => {
  const planned = [job("active-directory", { enabled: true })];
  const resolved = resolvePlannedConfigs({ personas: null, globals: null, locations: null }, { ...payload, mirrorPermissionsFromUser: "Jane Boss" }, "onboard", planned);
  assert.deepEqual(resolved[0].config, { enabled: true, mirrorFromUser: "Jane Boss" });
});

test("no mirror directive → no mirrorFromUser key", () => {
  const planned = [job("active-directory", { enabled: true })];
  const resolved = resolvePlannedConfigs({ personas: null, globals: null, locations: null }, payload, "onboard", planned);
  assert.equal("mirrorFromUser" in (resolved[0].config as Record<string, unknown>), false);
});

// ── M365 licensing rules (config.onboard.licenseRules) ───────────────────────────────────────────
const LIC_RULES = [
  { when: "needsComputer == true", licenses: ["Microsoft 365 E5"] },
  { when: "", licenses: ["Office 365 E1"] },
];

test("license rules: needs a computer → E5", () => {
  const planned = [job("m365", { licenseRules: LIC_RULES })];
  const r = resolvePlannedConfigs(client, { ...payload, needsComputer: true }, "onboard", planned);
  assert.deepEqual((r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).licenses, ["Microsoft 365 E5"]);
});

test("license rules: no computer → E1 default", () => {
  const planned = [job("m365", { licenseRules: LIC_RULES })];
  const r = resolvePlannedConfigs(client, { ...payload, needsComputer: false }, "onboard", planned);
  assert.deepEqual((r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).licenses, ["Office 365 E1"]);
});

test("license rules: explicit ticket productLicenses overrides the rule (left untouched)", () => {
  const planned = [job("m365", { licenseRules: LIC_RULES, licenses: ["Microsoft 365 E3"] })];
  const r = resolvePlannedConfigs(client, { ...payload, needsComputer: true, productLicenses: ["Microsoft 365 F3"] }, "onboard", planned);
  // rule did NOT run, so the static config.licenses stays as authored
  assert.deepEqual((r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).licenses, ["Microsoft 365 E3"]);
});

test("license rules ADD to the static base licenses (union, not replace)", () => {
  // LogicSource-style: a static add-on + a rule that picks the tier → BOTH get assigned.
  const planned = [job("m365", { licenses: ["Microsoft Defender for Office 365 (Plan 1)"], licenseRules: LIC_RULES })];
  const r = resolvePlannedConfigs(client, { ...payload, needsComputer: true }, "onboard", planned);
  assert.deepEqual((r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).licenses,
    ["Microsoft Defender for Office 365 (Plan 1)", "Microsoft 365 E5"]);
});

test("license rules: union de-dupes a license the base already lists", () => {
  const planned = [job("m365", { licenses: ["Office 365 E5"], licenseRules: [{ when: "needsComputer == true", licenses: ["Office 365 E5", "Power BI Pro"] }] })];
  const r = resolvePlannedConfigs(client, { ...payload, needsComputer: true }, "onboard", planned);
  assert.deepEqual((r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).licenses, ["Office 365 E5", "Power BI Pro"]);
});

test("license rules: a v2.0 client (no personas/globals) still gets rule-resolved licenses", () => {
  const planned = [job("m365", { licenseRules: LIC_RULES })];
  const r = resolvePlannedConfigs({}, { ...payload, needsComputer: true }, "onboard", planned);
  assert.deepEqual((r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).licenses, ["Microsoft 365 E5"]);
});

// m365 + entra are the same Graph module; when both are modeled the entra lane must not re-run the
// expensive EXO mirror — the planner defers it to m365 (skipExoFinish + no mirrorFromUser).
test("both m365 + entra modeled → entra lane defers the EXO finish to m365", () => {
  const planned = [job("m365", {}), job("entra", {})];
  const r = resolvePlannedConfigs({}, { ...payload, mirrorPermissionsFromUser: "Rodrigo Rapussi" }, "onboard", planned);
  const m365 = r.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>;
  const entra = r.find((j) => j.systemKey === "entra")!.config as Record<string, unknown>;
  assert.equal(m365.mirrorFromUser, "Rodrigo Rapussi");        // m365 keeps the mirror
  assert.equal(m365.skipExoFinish, undefined);
  assert.equal(entra.skipExoFinish, true);                      // entra defers
  assert.equal(entra.mirrorFromUser, undefined);               // and won't re-mirror groups
});

test("entra-only client still runs its own EXO mirror (no m365 to defer to)", () => {
  const planned = [job("entra", {})];
  const r = resolvePlannedConfigs({}, { ...payload, mirrorPermissionsFromUser: "Rodrigo Rapussi" }, "onboard", planned);
  const entra = r.find((j) => j.systemKey === "entra")!.config as Record<string, unknown>;
  assert.equal(entra.mirrorFromUser, "Rodrigo Rapussi");
  assert.equal(entra.skipExoFinish, undefined);
});

test("a matched location contributes its groups/OU/attributes to the directory jobs (B)", () => {
  const locClient = {
    personas: null, globals: null,
    locations: {
      FalconBOS: { city: "Boston", groups: ["FalconBOS", "FIA-Boston-LM"], ou: "OU=Boston,DC=x", attributes: { physicalDeliveryOfficeName: "Boston" } },
      FalconNYC: { city: "New York", groups: ["FalconNYC"] },
    },
  };
  const p = { firstName: "A", lastName: "B", officeLocation: "FalconBOS", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const planned = [job("active-directory", {}), job("m365", {}), job("servicenow", {})];
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", planned);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  const m365 = resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>;
  const sn = resolved.find((j) => j.systemKey === "servicenow")!.config as Record<string, unknown>;
  // Boston hire → FalconBOS + the printer group, unioned into every directory system.
  assert.deepEqual(ad.groups, ["FalconBOS", "FIA-Boston-LM"]);
  assert.deepEqual(m365.groups, ["FalconBOS", "FIA-Boston-LM"]);
  assert.equal(ad.ou, "OU=Boston,DC=x"); // OU only on AD
  assert.equal((ad.attributes as Record<string, string>).physicalDeliveryOfficeName, "Boston");
  assert.ok(!("groups" in sn)); // non-directory system untouched
  // a different office resolves to its own groups
  const nyc = resolvePlannedConfigs(locClient, { ...p, officeLocation: "FalconNYC" }, "onboard", planned);
  assert.deepEqual((nyc.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).groups, ["FalconNYC"]);
});

test("an ad-source group-based license is appended to the AD job's groups at plan time", () => {
  const noP = { personas: null, globals: null, locations: null };
  const planned = [
    job("active-directory", { groups: ["Existing Group"] }),
    job("m365", { licenses: [
      "Defender for Office 365",
      { name: "Microsoft 365 E3", assignVia: "group", group: "M365 E3 Users Group", groupSource: "ad" },
      { name: "Microsoft 365 E5", assignVia: "group", group: "E5 License Users", groupSource: "entra" },
    ] }),
  ];
  const p = { firstName: "A", lastName: "B", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(noP, p, "onboard", planned);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  // ad-source group appended (deduped, existing first); the entra-source one stays with m365.
  assert.deepEqual(ad.groups, ["Existing Group", "M365 E3 Users Group"]);
  const m365 = resolved.find((j) => j.systemKey === "m365")!.config as { licenses: unknown[] };
  assert.equal(m365.licenses.length, 3); // m365 config untouched — the runner notes ad-source entries
});

test("ad-source license group already in the AD groups is not duplicated", () => {
  const noP = { personas: null, globals: null, locations: null };
  const planned = [
    job("active-directory", { groups: ["m365 e3 users group"] }), // case-insensitive dup
    job("m365", { licenses: [{ name: "E3", assignVia: "group", group: "M365 E3 Users Group", groupSource: "ad" }] }),
  ];
  const p = { firstName: "A", lastName: "B", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(noP, p, "onboard", planned);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["m365 e3 users group"]);
});
