import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSystemConfig } from "./resolve";

// Proof: the v2.1 planner engine + the authored profiles/coretelligent.json reproduce the internal
// Create-NewUser script's decisions for representative onboards (OU, group union, attributes). The
// plan-time context here is what the planner will build from intake + profile.locations + persona.
const profile = JSON.parse(readFileSync(join(process.cwd(), "..", "profiles", "coretelligent.json"), "utf8"));

function adConfig(personaName: string, ctx: Record<string, unknown>) {
  const persona = profile.personas[personaName];
  const own = profile.systems.find((s: { key: string }) => s.key === "active-directory").onboard.config;
  return resolveSystemConfig("active-directory", { globals: profile.globals["active-directory"], persona: persona.systems["active-directory"], own }, ctx);
}

const base = {
  first: "John", last: "Doe", employmentType: "Full-Time", startDate: "06/15/26", extension: "4912",
  manager: "CN=Jane Boss,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local",
  did: "(650) 837-0491", mobile: "(631) 358-3326",
};
const US = { short: "US", name: "United States", code: 840 };

test("Field Services / CA / Full-Time: location OU, global+role group union, attributes", () => {
  const ad = adConfig("Field Services", {
    ...base, title: "Senior Client Support Engineer", role: { name: "Field Services" },
    location: { name: "CA", timezone: "Pacific Standard Time" }, country: US,
  });
  assert.equal(ad.ou, "OU=CA,OU=Field Services,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local");
  assert.deepEqual(ad.groups, [
    "Egnyte-CS-CORE", "Centrify - Egnyte Power Users", "RDS-Users", "VPN-Split", "Core-ALL",
    "DEPT-Field", "ExchStatusReport", "Notifications", "TechStaff", "SSO - Zoom Pro Users",
  ]);
  const a = ad.attributes as Record<string, string>;
  assert.equal(a.company, "Coretelligent");
  assert.equal(a.title, "Senior Client Support Engineer");
  assert.equal(a.department, "Field Services");
  assert.equal(a.c, "US");
  assert.equal(a.co, "United States");
  assert.equal(a.countryCode, "840");
  assert.equal(a.employeeType, "Full-Time");
  assert.equal(a.extensionAttribute4, "06/15/26");
  assert.equal(a.ipPhone, "4912");
  assert.equal(a.manager, base.manager);
  assert.equal(a.physicalDeliveryOfficeName, "CA");
  assert.equal("city" in a, false); // CA has no city in the locations table → attribute omitted
  assert.equal("state" in a, false);
});

test("Professional Services: title-conditional groups (PE vs PM)", () => {
  const loc = { location: { name: "MA" }, country: US };
  const pe = adConfig("Professional Services", { ...base, role: { name: "Professional Services" }, title: "Project Engineer", ...loc });
  assert.ok((pe.groups as string[]).includes("TEAM-ProfSvcs-Engineering"));
  assert.ok((pe.groups as string[]).includes("Project Engineers"));
  assert.ok(!(pe.groups as string[]).includes("Project Managers"));

  const pm = adConfig("Professional Services", { ...base, role: { name: "Professional Services" }, title: "Project Manager", ...loc });
  assert.ok((pm.groups as string[]).includes("Project Managers"));
  assert.ok((pm.groups as string[]).includes("Egnyte-CS-BIZDEV"));
  assert.ok(!(pm.groups as string[]).includes("Project Engineers"));
});

test("Remote Support: title regex drives the OU + RST groups", () => {
  const rs = adConfig("Remote Support", {
    ...base, role: { name: "Remote Support" }, title: "Remote Support Engineer II", location: { name: "MA" }, country: US,
  });
  assert.equal(rs.ou, "OU=Support,OU=Remote Support,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local");
  assert.ok((rs.groups as string[]).includes("Core-RST-Support"));
  assert.ok((rs.groups as string[]).includes("TEAM-RST-Support"));
});

test("Digital Transformation / India: country OU + Podshore-ALL, not the US/FT groups", () => {
  const dt = adConfig("Digital Transformation Services", {
    ...base, role: { name: "Digital Transformation Services" }, title: "Consultant",
    location: { name: "India", timezone: "India Standard Time" }, country: { short: "IN", name: "India", code: 356 },
  });
  assert.equal(dt.ou, "OU=Podshore,OU=Digital Transformation,OU=Users,OU=Coretelligent,DC=coretelligent,DC=local");
  assert.ok((dt.groups as string[]).includes("Podshore-ALL"));
  assert.ok(!(dt.groups as string[]).includes("RDS-Users")); // US/Full-Time only
});
