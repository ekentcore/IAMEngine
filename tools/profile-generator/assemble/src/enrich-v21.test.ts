import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceV21Enrichment, applyV21Enrichment, identitySystemKey, irRunbookText } from "./enrich-v21.js";
import type { Profile } from "./profile.js";
import type { IR } from "./ir.js";

test("coerceV21Enrichment: keeps well-formed signal, drops junk + placeholders + token names", () => {
  const e = coerceV21Enrichment({
    identityGroups: ["Azure-Files-Users", "Insurance", "  ", 5],
    attributes: { title: "{title}", company: "Apollon Wealth", ipPhone: "xxx-xxx-xxxx", bogus: { x: 1 } },
    usernamePattern: "{first}.{last}",
    personas: [
      { name: "Sales", titles: ["AE"], groups: ["Sales-Team"], ou: "OU=Sales" },
      { name: "{department}", groups: ["x"] }, // dropped: token name
      { name: "", groups: ["y"] },             // dropped: no name
    ],
    locations: [{ name: "NYC", city: "New York", timezone: "Eastern Standard Time" }, { name: "{office}" }],
  });
  assert.ok(e);
  assert.deepEqual(e!.identityGroups, ["Azure-Files-Users", "Insurance"]);
  assert.deepEqual(e!.attributes, { title: "{title}", company: "Apollon Wealth" });
  assert.equal(e!.usernamePattern, "{first}.{last}");
  assert.equal(e!.personas.length, 1);
  assert.equal(e!.personas[0].name, "Sales");
  assert.equal(e!.locations.length, 1);
  assert.equal(e!.locations[0].name, "NYC");
});

test("coerceV21Enrichment: null when nothing usable / bad input", () => {
  assert.equal(coerceV21Enrichment({ identityGroups: [], attributes: {}, personas: [], locations: [] }), null);
  assert.equal(coerceV21Enrichment(null), null);
});

test("identitySystemKey: active-directory > entra > m365 > null", () => {
  assert.equal(identitySystemKey([{ key: "servicenow" }, { key: "entra" }, { key: "active-directory" }]), "active-directory");
  assert.equal(identitySystemKey([{ key: "entra" }]), "entra");
  assert.equal(identitySystemKey([{ key: "zoom" }]), null);
});

test("applyV21Enrichment: folds groups/attributes into globals[entra], personas+locations top-level, bumps 2.1", () => {
  const profile = {
    schemaVersion: "2.0",
    client: { id: "x", name: "X", primaryDomain: "x.com" },
    identity: { backbone: "entra", usernamePatterns: ["{first}{last}@{domain}"] },
    secrets: {},
    systems: [{ key: "servicenow" }, { key: "entra" }],
  } as unknown as Profile;
  const e = coerceV21Enrichment({
    identityGroups: ["Azure-Files-Users"], attributes: { title: "{title}" }, usernamePattern: "{first}.{last}",
    personas: [{ name: "Sales", groups: ["Sales-Team"], ou: "OU=Sales" }],
    locations: [{ name: "NYC", timezone: "Eastern Standard Time" }],
  })!;
  applyV21Enrichment(profile, e);
  const p = profile as Profile & { globals?: any; personas?: any; locations?: any };
  assert.equal(profile.schemaVersion, "2.1");
  assert.deepEqual(p.globals.entra.groups, ["Azure-Files-Users"]);
  assert.deepEqual(p.globals.entra.attributes, { title: "{title}" });
  assert.equal(profile.identity.usernamePatterns[0], "{first}.{last}");
  assert.deepEqual(p.personas.Sales.systems.entra.groups, ["Sales-Team"]);
  assert.equal(p.locations.NYC.timezone, "Eastern Standard Time");
});

test("irRunbookText: stitches section headers + steps per action", () => {
  const ir = {
    client: { leaf: "Acme" },
    detected: [{ systemKey: "active-directory", action: "onboarding", section: "Active Directory", steps: ["Add to group Sales-Team"] }],
    unmodeled: [{ section: "Notes", action: "offboarding", steps: ["Disable account"] }],
  } as unknown as IR;
  const t = irRunbookText(ir);
  assert.match(t, /Client: Acme/);
  assert.match(t, /# Active Directory/);
  assert.match(t, /Add to group Sales-Team/);
  assert.match(t, /Disable account/);
});
