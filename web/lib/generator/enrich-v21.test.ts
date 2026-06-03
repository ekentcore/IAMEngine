import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceV21Enrichment, applyV21Enrichment, identitySystemKey } from "./enrich-v21";

test("coerceV21Enrichment: keeps well-formed groups/attributes/personas/locations", () => {
  const e = coerceV21Enrichment({
    identityGroups: ["Azure-Files-Users", "Insurance", "  ", 5],
    attributes: { title: "{title}", department: "{department}", company: "Apollon Wealth", bogus: { x: 1 } },
    usernamePattern: "{first}.{last}",
    personas: [
      { name: "Sales", titles: ["AE", "SDR"], groups: ["Sales-Team"], ou: "OU=Sales,DC=x" },
      { name: "", groups: ["nope"] }, // dropped: no name
    ],
    locations: [
      { name: "NYC", city: "New York", state: "NY", timezone: "Eastern Standard Time" },
      { city: "no name" }, // dropped: no name
    ],
  });
  assert.ok(e);
  assert.deepEqual(e!.identityGroups, ["Azure-Files-Users", "Insurance"]); // blanks + non-strings dropped
  assert.deepEqual(e!.attributes, { title: "{title}", department: "{department}", company: "Apollon Wealth" }); // object value dropped
  assert.equal(e!.usernamePattern, "{first}.{last}");
  assert.equal(e!.personas.length, 1);
  assert.equal(e!.personas[0].name, "Sales");
  assert.deepEqual(e!.personas[0].titles, ["AE", "SDR"]);
  assert.equal(e!.locations.length, 1);
  assert.equal(e!.locations[0].name, "NYC");
});

test("coerceV21Enrichment: drops placeholder attribute values and token-named locations/personas", () => {
  const e = coerceV21Enrichment({
    attributes: { title: "{title}", ipPhone: "xxx-xxx-xxxx", fax: "XXX-XXX-XXXX", ext: "X", company: "Real Co" },
    personas: [{ name: "{department}", groups: ["g"] }, { name: "Sales", groups: ["s"] }],
    locations: [{ name: "{office}", timezone: "UTC" }, { name: "Dallas", state: "TX" }],
  });
  assert.ok(e);
  // placeholder-only values (all x / X separators) are dropped; real tokens + literals kept
  assert.deepEqual(e!.attributes, { title: "{title}", company: "Real Co" });
  // a persona/location whose name is just a {token} is dropped (the LLM leaked a template)
  assert.equal(e!.personas.length, 1);
  assert.equal(e!.personas[0].name, "Sales");
  assert.equal(e!.locations.length, 1);
  assert.equal(e!.locations[0].name, "Dallas");
});

test("coerceV21Enrichment: returns null when nothing usable was extracted", () => {
  assert.equal(coerceV21Enrichment({ identityGroups: [], attributes: {}, personas: [], locations: [] }), null);
  assert.equal(coerceV21Enrichment(null), null);
  assert.equal(coerceV21Enrichment("not an object"), null);
});

test("identitySystemKey: prefers active-directory, else entra, else m365, else null", () => {
  assert.equal(identitySystemKey([{ key: "servicenow" }, { key: "active-directory" }, { key: "entra" }]), "active-directory");
  assert.equal(identitySystemKey([{ key: "servicenow" }, { key: "entra" }]), "entra");
  assert.equal(identitySystemKey([{ key: "m365" }, { key: "zoom" }]), "m365");
  assert.equal(identitySystemKey([{ key: "zoom" }]), null);
});

test("applyV21Enrichment: folds groups+attributes into globals of the identity system (entra, not just AD)", () => {
  const profile: any = {
    schemaVersion: "2.0",
    identity: { backbone: "entra", usernamePatterns: ["{first}{last}@{domain}"] },
    systems: [{ key: "servicenow" }, { key: "entra", onboard: { when: "always" } }],
  };
  const e = coerceV21Enrichment({
    identityGroups: ["Azure-Files-Users", "Insurance"],
    attributes: { title: "{title}", company: "Apollon Wealth" },
    usernamePattern: "{first}.{last}",
  })!;
  applyV21Enrichment(profile, e);

  assert.equal(profile.schemaVersion, "2.1");
  assert.deepEqual(profile.globals.entra.groups, ["Azure-Files-Users", "Insurance"]);
  assert.deepEqual(profile.globals.entra.attributes, { title: "{title}", company: "Apollon Wealth" });
  // username pattern hoisted in front (deduped)
  assert.equal(profile.identity.usernamePatterns[0], "{first}.{last}");
});

test("applyV21Enrichment: emits top-level personas + locations, persona fragment under the identity key", () => {
  const profile: any = {
    schemaVersion: "2.0",
    identity: { backbone: "ad-synced" },
    systems: [{ key: "active-directory", onboard: { when: "always" } }],
  };
  const e = coerceV21Enrichment({
    personas: [{ name: "Field Services", titles: ["Engineer"], groups: ["DEPT-Field"], ou: "OU=Field,DC=x" }],
    locations: [{ name: "CA", timezone: "Pacific Standard Time", country: { short: "US" } }],
  })!;
  applyV21Enrichment(profile, e);

  assert.equal(profile.schemaVersion, "2.1");
  assert.ok(profile.personas["Field Services"]);
  assert.deepEqual(profile.personas["Field Services"].titles, ["Engineer"]);
  // persona contributes a fragment under the identity system key, with groups + ou
  const frag = profile.personas["Field Services"].systems["active-directory"];
  assert.deepEqual(frag.groups, ["DEPT-Field"]);
  assert.equal(frag.ou, "OU=Field,DC=x");
  assert.equal(profile.locations.CA.timezone, "Pacific Standard Time");
  assert.equal(profile.locations.CA.country.short, "US");
});

test("applyV21Enrichment: no identity system → still emits personas/locations but skips globals", () => {
  const profile: any = { schemaVersion: "2.0", identity: {}, systems: [{ key: "zoom", onboard: { when: "always" } }] };
  const e = coerceV21Enrichment({ identityGroups: ["X-Users"], locations: [{ name: "HQ" }] })!;
  applyV21Enrichment(profile, e);
  assert.equal(profile.globals, undefined); // nowhere to put groups
  assert.equal(profile.locations.HQ.name ?? "HQ", "HQ");
  assert.equal(profile.schemaVersion, "2.1"); // locations alone still bumps
});
