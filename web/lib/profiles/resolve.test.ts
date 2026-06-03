import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGroups, resolveAttributes, resolveOu, resolveSystemConfig } from "./resolve";

const ctx = {
  first: "John", last: "Doe", title: "Project Engineer", department: "Delivery",
  employmentType: "Full-Time", startDate: "2026-06-15", extension: "1234",
  location: { name: "CA" }, country: { short: "US" }, avd: true,
};

test("resolveGroups: plain (interpolated) + conditional bundles, deduped", () => {
  const groups = resolveGroups(
    [
      "All-Staff",
      "SSO-{location.name}-Users",
      { groups: ["AVD-Users"], when: "avd == true" },
      { groups: ["Onsite"], when: "avd == false" },
      "All-Staff", // dup
    ],
    ctx
  );
  assert.deepEqual(groups, ["All-Staff", "SSO-CA-Users", "AVD-Users"]);
});

test("resolveAttributes: plain templates + conditional first-match", () => {
  const attrs = resolveAttributes(
    {
      title: "{title}",
      extensionAttribute4: "{startDate}",
      ipPhone: "{extension}",
      co: [
        { value: "United States", when: "country.short == US" },
        { value: "Canada", when: "country.short == CA" },
      ],
      employeeType: [{ value: "FTE", when: "employmentType == Full-Time" }, { value: "Contractor" }],
    },
    ctx
  );
  assert.equal(attrs.title, "Project Engineer");
  assert.equal(attrs.extensionAttribute4, "2026-06-15");
  assert.equal(attrs.ipPhone, "1234");
  assert.equal(attrs.co, "United States");
  assert.equal(attrs.employeeType, "FTE");
});

test("resolveAttributes: an unmatched conditional with no default is omitted", () => {
  const attrs = resolveAttributes({ co: [{ value: "Mexico", when: "country.short == MX" }] }, ctx);
  assert.equal("co" in attrs, false);
});

test("resolveOu: string, and first-matching conditional path", () => {
  assert.equal(resolveOu("OU=Users,DC=core,DC=tech", ctx), "OU=Users,DC=core,DC=tech");
  const ou = resolveOu(
    [
      { path: "OU=CA,OU=Field,DC=core,DC=tech", when: "location.name == CA" },
      { path: "OU=Default,DC=core,DC=tech" },
    ],
    ctx
  );
  assert.equal(ou, "OU=CA,OU=Field,DC=core,DC=tech");
});

test("resolveSystemConfig: globals + persona + own — groups union, own overrides scalars", () => {
  const resolved = resolveSystemConfig(
    "active-directory",
    {
      globals: { groups: ["All-Staff"] },
      persona: { groups: ["Engineers"], ou: "OU=Eng,DC=core,DC=tech", attributes: { department: "{department}" } },
      own: { groups: ["{location.name}-Local"], homeDrive: { unc: "\\\\srv\\users\\{first}" } },
    },
    ctx
  );
  // groups: union across all three layers, interpolated
  assert.deepEqual(resolved.groups, ["All-Staff", "Engineers", "CA-Local"]);
  assert.equal(resolved.ou, "OU=Eng,DC=core,DC=tech");
  assert.equal((resolved.attributes as Record<string, string>).department, "Delivery");
  // arbitrary nested keys pass through, with string templates interpolated
  assert.equal((resolved.homeDrive as { unc: string }).unc, "\\\\srv\\users\\John");
});

test("resolveSystemConfig: own scalar overrides persona/globals", () => {
  const resolved = resolveSystemConfig(
    "m365",
    { persona: { accountSkuId: "E5" }, own: { accountSkuId: "E3" } },
    ctx
  );
  assert.equal(resolved.accountSkuId, "E3");
});
