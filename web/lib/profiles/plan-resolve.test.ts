import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePlannedConfigs, personaSystemKeys } from "./plan-resolve";
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

test("personaSystemKeys: onboard = the persona's systems keys; no persona/personas -> empty", () => {
  const c = {
    personas: {
      Ops: { titles: ["Ops Engineer"], systems: { xmatters: {}, m365: { groups: ["Ops-All"] } }, offboardSystems: { pagerduty: {} } },
    },
    locations: null,
  };
  const on = personaSystemKeys(c, { department: "Ops" }, "onboard");
  assert.deepEqual([...on].sort(), ["m365", "xmatters"]);
  // Unmatched persona -> empty set (a by_persona system is simply excluded).
  assert.equal(personaSystemKeys(c, { department: "Finance" }, "onboard").size, 0);
  assert.equal(personaSystemKeys({ personas: null, locations: null }, { department: "Ops" }, "onboard").size, 0);
});

test("personaSystemKeys: offboard is the union of systems + offboardSystems (granted -> cleaned up)", () => {
  const c = {
    personas: { Ops: { systems: { xmatters: {} }, offboardSystems: { pagerduty: {} } } },
    locations: null,
  };
  const off = personaSystemKeys(c, { department: "Ops" }, "offboard");
  assert.deepEqual([...off].sort(), ["pagerduty", "xmatters"]);
});

// FR #4: the requestor's ticket-picked DLs / security groups were captured on the payload but
// never merged into any job config — a non-default DL added to the case was silently dropped.
test("requested email DLs land on the m365 job and flow to exchange namedGroups", () => {
  const planned = [job("m365", { groups: ["Static Team"] }), job("exchange", {})];
  const p = { ...payload, emailDistroGroups: ["Administrative Ops", "New York", "static team"] };
  const resolved = resolvePlannedConfigs({}, p, "onboard", planned);
  const m365 = resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>;
  // unioned, case-insensitively de-duped against the client's static groups
  assert.deepEqual(m365.groups, ["Static Team", "Administrative Ops", "New York"]);
  const exch = resolved.find((j) => j.systemKey === "exchange")!.config as Record<string, unknown>;
  assert.deepEqual(exch.namedGroups, ["Static Team", "Administrative Ops", "New York"]);
});

test("requested security groups land on the MASTERING lane only: AD when planned, else Graph", () => {
  // Hybrid client (AD lane planned): AD masters security groups; adding them to Graph too made
  // every onboard land orange (Graph refuses the write on an on-prem-synced group -> WARN).
  const hybrid = resolvePlannedConfigs({}, { ...payload, securityGroups: ["SG-Finance"] }, "onboard",
    [job("active-directory", {}), job("m365", {}), job("exchange", {})]);
  assert.deepEqual((hybrid.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).groups, ["SG-Finance"]);
  assert.equal((hybrid.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).groups, undefined);
  assert.equal((hybrid.find((j) => j.systemKey === "exchange")!.config as Record<string, unknown>).groups, undefined);
  // Cloud-only client: the Graph lane owns them.
  const cloud = resolvePlannedConfigs({}, { ...payload, securityGroups: ["SG-Finance"] }, "onboard", [job("m365", {})]);
  assert.deepEqual((cloud.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).groups, ["SG-Finance"]);
});

test("exchange-only client (no Graph lane): requested DLs go straight to exchange namedGroups", () => {
  const planned = [job("exchange", { namedGroups: ["Existing DL"] })];
  const p = { ...payload, emailDistroGroups: ["New York", "existing dl"] };
  const resolved = resolvePlannedConfigs({}, p, "onboard", planned);
  const exch = resolved.find((j) => j.systemKey === "exchange")!.config as Record<string, unknown>;
  assert.deepEqual(exch.namedGroups, ["Existing DL", "New York"]);
});

test("no requested groups → configs untouched", () => {
  const planned = [job("m365", { groups: ["Static Team"] })];
  const resolved = resolvePlannedConfigs({}, { ...payload }, "onboard", planned);
  assert.deepEqual((resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).groups, ["Static Team"]);
});

// FR #3: a re-hire's old account is the EXPECTED find — adopt it instead of pausing the case
// with a username-collision decision. m365/entra ONLY: their executor consults the policy inside
// its name-matched branch. AD/Google auto-adopt a name match already, and for them "adopt" is the
// operator's FORCE override that skips the name check — a plan-injected default there would let a
// rehire take over a different person's live account.
test("isRehire → m365/entra default to adopt; AD/Google (force-override semantics) do NOT", () => {
  const planned = [job("active-directory", {}), job("m365", {}), job("entra", {}), job("google-workspace", {}), job("exchange", {}), job("servicenow", {})];
  const resolved = resolvePlannedConfigs({}, { ...payload, isRehire: true }, "onboard", planned);
  for (const k of ["m365", "entra"]) {
    assert.equal((resolved.find((j) => j.systemKey === k)!.config as Record<string, unknown>).usernameCollisionPolicy, "adopt", k);
  }
  for (const k of ["active-directory", "google-workspace", "exchange"]) {
    assert.equal((resolved.find((j) => j.systemKey === k)!.config as Record<string, unknown>).usernameCollisionPolicy, undefined, k);
  }
});

test("isRehire does not override an explicit collision policy, and non-rehires get none", () => {
  const planned = [job("m365", { usernameCollisionPolicy: "new" })];
  const resolved = resolvePlannedConfigs({}, { ...payload, isRehire: true }, "onboard", planned);
  assert.equal((resolved[0].config as Record<string, unknown>).usernameCollisionPolicy, "new");
  const noRehire = resolvePlannedConfigs({}, { ...payload, isRehire: false }, "onboard", [job("m365", {})]);
  assert.equal((noRehire[0].config as Record<string, unknown>).usernameCollisionPolicy, undefined);
});

// Security: requestor free-text can NEVER add someone to a privileged group — the runner binds as
// SYSTEM on a DC, and "Domain Admins" in a form field must not make a hire a domain admin.
test("requested privileged groups are filtered out of the plan", () => {
  const planned = [job("active-directory", {}), job("m365", {})];
  const p = { ...payload, securityGroups: ["Domain Admins", "SG-Finance", "enterprise admins"], emailDistroGroups: ["Administrators", "Team"] };
  const resolved = resolvePlannedConfigs({}, p, "onboard", planned);
  assert.deepEqual((resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).groups, ["SG-Finance"]);
  assert.deepEqual((resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).groups, ["Team"]);
});

// FR #30: operator-typed "additional groups" on the case review panel merge into the same
// mastering-lane routing as securityGroups (comma/semicolon string OR array), through the same
// protected-groups filter.
test("extraGroups land on the AD lane when the client has one", () => {
  const planned = [job("active-directory", {}), job("m365", {})];
  const resolved = resolvePlannedConfigs({}, { ...payload, extraGroups: "GIS Users, Finance Share" }, "onboard", planned);
  assert.deepEqual((resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).groups, ["GIS Users", "Finance Share"]);
  assert.equal((resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).groups, undefined);
});

test("extraGroups never add a protected group", () => {
  const planned = [job("active-directory", {})];
  const resolved = resolvePlannedConfigs({}, { ...payload, extraGroups: ["Domain Admins", "Sales"] }, "onboard", planned);
  assert.deepEqual((resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).groups, ["Sales"]);
});

test("a matched location's persisted printers emit one manual 'printers' job", () => {
  const locClient = {
    personas: null, globals: null,
    locations: {
      Boston: { city: "Boston", groups: ["FalconBOS"], printers: ["HP-Reception", "MFP-3rd"] },
    },
  };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const planned = [job("active-directory", {}), job("m365", {})];
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", planned);
  // groups still union into directory jobs
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["FalconBOS"]);
  // exactly one manual printers job, with the note
  const printerJobs = resolved.filter((j) => j.systemKey === "printers");
  assert.equal(printerJobs.length, 1);
  assert.equal(printerJobs[0].mode, "manual");
  assert.equal(printerJobs[0].requiresApproval, false);
  assert.deepEqual(printerJobs[0].secretNames, []);
  assert.equal((printerJobs[0].config as { note?: string }).note, "Map printers at Boston: HP-Reception, MFP-3rd");
});

test("un-migrated location (no printers key) emits no printers job and preserves group union", () => {
  const locClient = {
    personas: null, globals: null,
    locations: { Boston: { city: "Boston", groups: ["FalconBOS", "TypedPrinter"] } },
  };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", [job("active-directory", {})]);
  assert.equal(resolved.filter((j) => j.systemKey === "printers").length, 0);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["FalconBOS", "TypedPrinter"]); // unchanged legacy behavior
});

test("printers only (no groups) still emits the manual job", () => {
  const locClient = { personas: null, globals: null, locations: { Boston: { city: "Boston", printers: ["HP-Reception"] } } };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", [job("active-directory", {})]);
  assert.equal(resolved.filter((j) => j.systemKey === "printers").length, 1);
});

// ── cloud-only location groups must not be pushed to the AD lane ──────────────────────────────────
// A location group is multi-lane, but a group discovery proves is cloud-only (in the tenant's Entra
// groups, absent from the DC's AD groups) makes the AD runner warn "group not found in AD". Skip it
// on the AD lane; keep it on the cloud lanes. Only filter with positive catalog evidence.
const houstonPayload = { firstName: "A", lastName: "B", officeLocation: "Houston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };

test("cloud-only location group (in cloudGroups, not adObjects) is skipped on AD but kept on m365", () => {
  const locClient = {
    personas: null, globals: null,
    adObjects: { groups: ["Back Office Users"] },
    cloudGroups: { groups: [{ name: "Houston Printix Group", type: "Security" }] },
    locations: { Houston: { city: "Houston", groups: ["Houston Printix Group"] } },
  };
  const resolved = resolvePlannedConfigs(locClient, houstonPayload, "onboard",
    [job("active-directory", { groups: ["Back Office Users"] }), job("m365", {})]);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  const m365 = resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["Back Office Users"]); // Printix NOT added to AD
  assert.deepEqual(m365.groups, ["Houston Printix Group"]); // still added in 365
});

test("cloud-only filter is case-insensitive on the catalog names", () => {
  const locClient = {
    personas: null, globals: null,
    adObjects: { groups: [] },
    cloudGroups: { groups: [{ name: "houston printix group" }] },
    locations: { Houston: { city: "Houston", groups: ["Houston Printix Group"] } },
  };
  const resolved = resolvePlannedConfigs(locClient, houstonPayload, "onboard", [job("active-directory", {})]);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, []); // skipped despite casing difference
});

test("location group that IS a discovered AD group stays on the AD lane", () => {
  const locClient = {
    personas: null, globals: null,
    adObjects: { groups: ["FalconBOS"] },
    cloudGroups: { groups: [{ name: "FalconBOS" }] }, // present in both → NOT cloud-only
    locations: { Boston: { city: "Boston", groups: ["FalconBOS"] } },
  };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", [job("active-directory", {})]);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["FalconBOS"]);
});

test("no discovery catalogs → legacy union into AD is preserved (nothing silently dropped)", () => {
  const locClient = { personas: null, globals: null, locations: { Houston: { city: "Houston", groups: ["Houston Printix Group"] } } };
  const resolved = resolvePlannedConfigs(locClient, houstonPayload, "onboard", [job("active-directory", {})]);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["Houston Printix Group"]);
});

// ── FR #0000021: offboard hide-from-GAL injection ────────────────────────────────────────────────
const galJob = (systemKey: string, config: Record<string, unknown> = {}): PlannedJob => job(systemKey, config);
const galClient = {}; // v2.0 client: no personas/globals — GAL default must still apply
function cfgOf(jobs: PlannedJob[], key: string) {
  return (jobs.find((j) => j.systemKey === key)?.config ?? {}) as Record<string, unknown>;
}

test("offboard hide-from-GAL: defaults hideFromGal=true on exchange and google-workspace", () => {
  const out = resolvePlannedConfigs(galClient, {}, "offboard", [galJob("exchange"), galJob("google-workspace"), galJob("m365")]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, true);
  assert.equal(cfgOf(out, "google-workspace").hideFromGal, true);
  // never on the Graph lane
  assert.equal(cfgOf(out, "m365").hideFromGal, undefined);
});

test("offboard hide-from-GAL: per-case skipGalHide=true suppresses it on every lane", () => {
  const out = resolvePlannedConfigs(galClient, { skipGalHide: true }, "offboard", [galJob("exchange"), galJob("google-workspace")]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined);
  assert.equal(cfgOf(out, "google-workspace").hideFromGal, undefined);
});

test("offboard hide-from-GAL: per-client opt-out (hideFromGal:false) is preserved, not overwritten", () => {
  const out = resolvePlannedConfigs(galClient, {}, "offboard", [galJob("exchange", { hideFromGal: false })]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, false);
});

test("offboard hide-from-GAL: AD attribute config takes over — exchange lane is left untouched", () => {
  const out = resolvePlannedConfigs(galClient, {}, "offboard", [
    galJob("exchange"),
    galJob("active-directory", { hideFromGal: { attribute: "msExchHideFromAddressLists", value: "TRUE" } }),
  ]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined); // AD owns it
  // AD job config is untouched by this feature
  assert.equal((cfgOf(out, "active-directory").hideFromGal as Record<string, unknown>).attribute, "msExchHideFromAddressLists");
});

test("offboard hide-from-GAL: when AD owns the hide, an explicit hideFromGal:true on the exchange lane is stamped false (no doomed EXO attempt)", () => {
  const out = resolvePlannedConfigs(galClient, {}, "offboard", [
    galJob("exchange", { hideFromGal: true }),
    galJob("active-directory", { hideFromGal: { attribute: "msExchHideFromAddressLists", value: "TRUE" } }),
  ]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, false); // overridden — EXO would WARN on the synced mailbox
  assert.equal((cfgOf(out, "active-directory").hideFromGal as Record<string, unknown>).attribute, "msExchHideFromAddressLists");
});

test("offboard hide-from-GAL: bare hideFromGal:true on the AD lane does NOT count as AD-owned — exchange still hides", () => {
  const out = resolvePlannedConfigs(galClient, {}, "offboard", [galJob("exchange"), galJob("active-directory", { hideFromGal: true })]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, true);
});

test("offboard hide-from-GAL: does nothing on onboard", () => {
  const out = resolvePlannedConfigs(galClient, {}, "onboard", [galJob("exchange")]);
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined);
});

// ── FR #0000036: ad_synced clients hide via the AD lane (EXO can't modify a synced mailbox) ─────
const adSyncedGalClient = { backbone: "ad_synced" };

test("offboard hide-from-GAL: ad_synced injects the AD attribute shape and exchange stands down", () => {
  const out = resolvePlannedConfigs(adSyncedGalClient, {}, "offboard", [galJob("exchange"), galJob("active-directory")]);
  assert.deepEqual(cfgOf(out, "active-directory").hideFromGal, { attribute: "msExchHideFromAddressLists", value: "TRUE" });
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined); // AD owns it — INSTEAD of EXO, not in addition
});

test("offboard hide-from-GAL: ad_synced + per-case skipGalHide touches neither lane", () => {
  const out = resolvePlannedConfigs(adSyncedGalClient, { skipGalHide: true }, "offboard", [galJob("exchange"), galJob("active-directory")]);
  assert.equal(cfgOf(out, "active-directory").hideFromGal, undefined);
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined);
});

test("offboard hide-from-GAL: ad_synced preserves an explicit client AD attribute verbatim", () => {
  const out = resolvePlannedConfigs(adSyncedGalClient, {}, "offboard", [
    galJob("exchange"),
    galJob("active-directory", { hideFromGal: { attribute: "msDS-cloudExtensionAttribute1", value: "HideFromGAL" } }),
  ]);
  assert.deepEqual(cfgOf(out, "active-directory").hideFromGal, { attribute: "msDS-cloudExtensionAttribute1", value: "HideFromGAL" });
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined);
});

test("offboard hide-from-GAL: ad_synced + exchange-lane opt-out means NO AD injection (not re-opted-in via AD)", () => {
  const out = resolvePlannedConfigs(adSyncedGalClient, {}, "offboard", [galJob("exchange", { hideFromGal: false }), galJob("active-directory")]);
  assert.equal(cfgOf(out, "active-directory").hideFromGal, undefined);
  assert.equal(cfgOf(out, "exchange").hideFromGal, false);
});

test("offboard hide-from-GAL: ad_synced upgrades a bare hideFromGal:true on the AD lane to the attribute shape", () => {
  const out = resolvePlannedConfigs(adSyncedGalClient, {}, "offboard", [galJob("exchange"), galJob("active-directory", { hideFromGal: true })]);
  assert.deepEqual(cfgOf(out, "active-directory").hideFromGal, { attribute: "msExchHideFromAddressLists", value: "TRUE" });
  assert.equal(cfgOf(out, "exchange").hideFromGal, undefined);
});

test("offboard hide-from-GAL: ad_synced + explicit hideFromGal:true on the exchange lane → AD injected, exchange stamped false", () => {
  const out = resolvePlannedConfigs(adSyncedGalClient, {}, "offboard", [galJob("exchange", { hideFromGal: true }), galJob("active-directory")]);
  assert.deepEqual(cfgOf(out, "active-directory").hideFromGal, { attribute: "msExchHideFromAddressLists", value: "TRUE" });
  assert.equal(cfgOf(out, "exchange").hideFromGal, false);
});

test("offboard hide-from-GAL: entra backbone never injects on the AD lane (regression)", () => {
  const out = resolvePlannedConfigs({ backbone: "entra" }, {}, "offboard", [galJob("exchange"), galJob("active-directory")]);
  assert.equal(cfgOf(out, "active-directory").hideFromGal, undefined);
  assert.equal(cfgOf(out, "exchange").hideFromGal, true);
});

// FR #25 — AD-synced clients must not create cloud accounts unless explicitly allowed. The planner
// stamps a create policy onto the m365/entra onboard jobs the runner enforces at its create gate.
test("ad_synced client stamps cloudCreate:'deny' on m365 and entra onboard jobs", () => {
  const adClient = { backbone: "ad_synced", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(adClient, payload, "onboard", [job("m365", {}), job("entra", {}), job("active-directory", {})]);
  assert.equal((resolved.find((j) => j.systemKey === "m365")!.config as Record<string, unknown>).cloudCreate, "deny");
  assert.equal((resolved.find((j) => j.systemKey === "entra")!.config as Record<string, unknown>).cloudCreate, "deny");
  // The AD lane is never stamped.
  assert.equal((resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>).cloudCreate, undefined);
});

test("ad_synced with the persistent allowCloudCreate flag stamps 'allow'", () => {
  const adClient = { backbone: "ad_synced", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(adClient, payload, "onboard", [job("m365", { allowCloudCreate: true })]);
  assert.equal((resolved[0].config as Record<string, unknown>).cloudCreate, "allow");
});

test("ad_synced with the per-case override stamps 'allow'", () => {
  const adClient = { backbone: "ad_synced", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(adClient, { ...payload, allowCloudCreate: true }, "onboard", [job("m365", {})]);
  assert.equal((resolved[0].config as Record<string, unknown>).cloudCreate, "allow");
});

test("non-ad-synced (entra) backbone never stamps cloudCreate", () => {
  const entraClient = { backbone: "entra", personas: null, globals: null, locations: null };
  const resolved = resolvePlannedConfigs(entraClient, payload, "onboard", [job("m365", {}), job("entra", {})]);
  assert.equal((resolved[0].config as Record<string, unknown>).cloudCreate, undefined);
  assert.equal((resolved[1].config as Record<string, unknown>).cloudCreate, undefined);
});
