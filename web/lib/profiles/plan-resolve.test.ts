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
  return { systemKey, sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, secretNames: [], config };
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
