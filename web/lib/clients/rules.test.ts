import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRules, collectConditions } from "./rules";

const good = {
  globals: {
    "active-directory": {
      groups: ["Core-ALL", { groups: ["Podshore-ALL"], when: "country.short == IN" }],
      attributes: { title: "{title}", office: [{ value: "BLR", when: "country.short == IN" }, { value: "HQ" }] },
    },
  },
  personas: {
    "Field Services": {
      titles: ["Field Engineer"],
      match: "role.name == Field Services",
      systems: {
        "active-directory": {
          ou: [{ path: "OU=CA,...", when: "location.name == CA" }, { path: "OU=Other,..." }],
          groups: [{ groups: ["FS-ALL"], when: "employmentType == Full-Time" }],
        },
      },
    },
  },
};

test("validateRules accepts a well-formed payload with valid conditions", () => {
  const r = validateRules(good);
  assert.equal(r.ok, true);
});

test("collectConditions finds every when/match across globals + personas", () => {
  const all = collectConditions(good).map((c) => c.expr).sort();
  assert.deepEqual(all, [
    "country.short == IN", // attribute office
    "country.short == IN", // group rule
    "employmentType == Full-Time",
    "location.name == CA",
    "role.name == Field Services",
  ].sort());
});

test("validateRules rejects a bad condition and says where", () => {
  const bad = { globals: { "active-directory": { groups: [{ groups: ["X"], when: "country.short IN" }] } } };
  const r = validateRules(bad);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Everyone · active-directory group rule/);
});

test("validateRules rejects a bad persona match condition", () => {
  const bad = { personas: { Sales: { match: "department equals Sales" } } };
  const r = validateRules(bad);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Persona "Sales" match/);
});

test("validateRules rejects non-object globals/personas", () => {
  assert.equal(validateRules({ globals: [] }).ok, false);
  assert.equal(validateRules({ personas: "x" }).ok, false);
  assert.equal(validateRules(null).ok, false);
});

test("validateRules accepts empty payload (clearing rules)", () => {
  assert.equal(validateRules({}).ok, true);
  assert.equal(validateRules({ globals: {}, personas: {} }).ok, true);
});
