import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanContext, selectPersona } from "./context";

const personas = {
  "Field Services": { titles: ["Engineer"], systems: { "active-directory": { ou: "x" } } },
  "Remote Support": { match: "title ~= ^Remote Support", systems: {} },
};
const locations = {
  CA: { timezone: "Pacific Standard Time", country: { short: "US", name: "United States", code: 840 } },
  MA: { city: "Needham", state: "MA", country: { short: "US", name: "United States", code: 840 } },
};

test("selectPersona: by role name (case-insensitive), else by match condition, else null", () => {
  assert.equal(selectPersona("field services", personas, {})?.name, "Field Services");
  assert.equal(selectPersona("Field Services", personas, {})?.name, "Field Services");
  assert.equal(selectPersona(null, personas, { title: "Remote Support Engineer II" })?.name, "Remote Support");
  assert.equal(selectPersona("Nope", personas, { title: "Accountant" }), null);
});

test("buildPlanContext: maps payload, enriches location, hoists country, selects persona", () => {
  const payload = {
    firstName: "John", lastName: "Doe", jobTitle: "Senior Client Support Engineer",
    employmentType: "Full-Time", startDate: "06/15/26", mobilePhone: "(631) 358-3326",
    managerName: "Jane Boss", department: "Field Services", officeLocation: "CA",
    samAccountName: "jdoe", userPrincipalName: "jdoe@core.tech", primaryDomain: "core.tech",
    avd: true,
  };
  const { context, persona } = buildPlanContext(payload, { personas, locations });

  assert.equal(persona?.name, "Field Services");
  assert.equal(context.first, "John");
  assert.equal(context.last, "Doe");
  assert.equal(context.title, "Senior Client Support Engineer");
  assert.equal((context.role as { name: string }).name, "Field Services");
  assert.equal((context.location as { name: string }).name, "CA");
  assert.equal((context.location as { timezone: string }).timezone, "Pacific Standard Time");
  assert.equal((context.country as { short: string }).short, "US"); // hoisted to top level
  assert.equal((context.country as { code: number }).code, 840);
  assert.equal(context.manager, "Jane Boss");
  assert.equal(context.avd, true); // intake booleans pass through
});

test("buildPlanContext: matches a location when the office string contains the key", () => {
  const { context } = buildPlanContext({ officeLocation: "Needham, MA office", department: "x" }, { personas, locations });
  assert.equal((context.location as { name: string }).name, "MA");
  assert.equal((context.location as { city: string }).city, "Needham");
});

test("buildPlanContext: selects the persona from the intake roles[] list", () => {
  const { persona } = buildPlanContext({ roles: ["Field Services"], firstName: "A", lastName: "B" }, { personas, locations });
  assert.equal(persona?.name, "Field Services");
});

test("matchLocation uses word boundaries — a city like 'Cambridge' is not location CA", () => {
  const { context } = buildPlanContext({ officeLocation: "Cambridge campus", department: "x" }, { personas, locations });
  // 'ca' is a substring of 'cambridge' but not a whole word → no CA match
  assert.notEqual((context.location as { name?: string }).name, "CA");
  // a real whole-word location still matches
  assert.equal((buildPlanContext({ officeLocation: "Cambridge, MA", department: "x" }, { personas, locations }).context.location as { name: string }).name, "MA");
});

test("buildPlanContext: no persona/location data still yields a usable context", () => {
  const { context, persona } = buildPlanContext({ firstName: "A", lastName: "B" }, { personas: null, locations: null });
  assert.equal(persona, null);
  assert.equal(context.first, "A");
  assert.equal((context.role as undefined), undefined);
});
