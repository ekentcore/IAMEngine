import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntake, deriveIdentity, emailTemplateFields, applyUsernamePattern } from "./intake-mapper";
import type { SnUserMgmtRecord } from "./intake";

// Build a raw {value, display_value} record from a plain map (value === display unless given).
function rec(fields: Record<string, string | [string, string]>): SnUserMgmtRecord {
  const out: SnUserMgmtRecord = {};
  for (const [k, v] of Object.entries(fields)) {
    const [value, display] = Array.isArray(v) ? v : [v, v];
    out[k] = { value, display_value: display } as never;
  }
  return out;
}

const onboard = rec({
  number: "UM0028740",
  short_description: "ONB - Jane Doe",
  subcategory: "User Onboarding",
  account: "client-sys-id",
  u_first: "Jane",
  u_last: "Van Doe",
  u_title: "Analyst",
  u_department: "Finance",
  u_office_location: ["c3b8...", "United States"],
  u_personal_phone: "5160000000",
  u_personal_email: "jane.personal@gmail.com",
  u_start_date: "2026-07-06 12:00:00",
  u_manager_name: ["b99...", "Evan Kent"],
  u_product_licenses: ["52d,01e", "Microsoft 365 Copilot, Microsoft 365 E3"],
});

test("onboard payload emits the canonical identity fields the modules read", () => {
  const { action, payload } = normalizeIntake(onboard);
  assert.equal(action, "onboard");
  assert.equal(payload.displayName, "Jane Van Doe");
  assert.equal(payload.jobTitle, "Analyst"); // PascalCase modules read JobTitle
  assert.equal(payload.mobilePhone, "5160000000"); // -> MobilePhone
  assert.equal(payload.usageLocation, "US"); // from "United States"
  assert.deepEqual(payload.productLicenses, ["Microsoft 365 Copilot", "Microsoft 365 E3"]);
  assert.equal(payload.managerName, "Evan Kent");
});

test("usageLocation resolves from a US state/city (not blind US default) and flags nothing", () => {
  const p = normalizeIntake(rec({ number: "UM1", subcategory: "30000", u_first: "A", u_last: "B", u_office_location: ["x", "Atlanta, GA"] })).payload;
  assert.equal(p.usageLocation, "US");
  assert.equal(p.usageLocationDerived, true);
  assert.deepEqual(p.unknownFields, []);
});

test("usageLocation falls back to the contact timezone when the office location is unclear", () => {
  const p = normalizeIntake(rec({ number: "UM2", subcategory: "30000", u_first: "A", u_last: "B", u_office_location: ["x", "HQ"], u_new_contact_time_zone: ["x", "US/Eastern"] })).payload;
  assert.equal(p.usageLocation, "US");
  assert.equal(p.usageLocationDerived, true);
});

test("usageLocation is FLAGGED (not silently US) when neither location nor timezone is recognized", () => {
  const p = normalizeIntake(rec({ number: "UM3", subcategory: "30000", u_first: "A", u_last: "B", u_office_location: ["x", "Mars Office"] })).payload;
  assert.equal(p.usageLocation, "US"); // safe default so onboarding isn't blocked
  assert.equal(p.usageLocationDerived, false);
  const unk = p.unknownFields as { field: string }[];
  assert.equal(unk.length, 1);
  assert.equal(unk[0].field, "usageLocation");
});

test("a non-US country resolves correctly", () => {
  const p = normalizeIntake(rec({ number: "UM4", subcategory: "30000", u_first: "A", u_last: "B", u_office_location: ["x", "London, United Kingdom"] })).payload;
  assert.equal(p.usageLocation, "GB");
});

test("deriveAction prefers the coded subcategory value over display text", () => {
  // 30100 = User Offboarding, regardless of the display text / short description.
  const offb = rec({ number: "UM0028680", subcategory: ["30100", "User Offboarding"], short_description: "ONB - typo'd title" });
  assert.equal(normalizeIntake(offb).action, "offboard");
  // 30000 = User Onboarding.
  const onb = rec({ number: "UM0028740", subcategory: ["30000", "User Onboarding"] });
  assert.equal(normalizeIntake(onb).action, "onboard");
  // No coded value: fall back to the display-text / short_description match.
  const fallback = rec({ number: "UM0028999", subcategory: "Offboard User", short_description: "Offboard - Jane" });
  assert.equal(normalizeIntake(fallback).action, "offboard");
});

test("applyUsernamePattern supports the profile tokens and lowercases the local part", () => {
  const vals = { first: "Jane", last: "Van Doe", mi: "Q", domain: "61commodities.com" };
  assert.equal(applyUsernamePattern("{first}{last}@{domain}", vals), "janevandoe@61commodities.com");
  assert.equal(applyUsernamePattern("{first}.{last}@{domain}", vals), "jane.vandoe@61commodities.com");
  assert.equal(applyUsernamePattern("{firstInitial}{last}@{domain}", vals), "jvandoe@61commodities.com");
});

test("deriveIdentity computes UPN / SamAccountName from the client's pattern + domain", () => {
  const { payload } = normalizeIntake(onboard);
  const enriched = deriveIdentity(payload, {
    usernamePatterns: ["{first}.{last}@{domain}"],
    primaryDomain: "Acme.com",
  });
  assert.equal(enriched.userPrincipalName, "jane.vandoe@acme.com");
  assert.equal(enriched.samAccountName, "jane.vandoe");
  assert.equal(enriched.mailNickname, "jane.vandoe");
  assert.equal(enriched.primaryDomain, "acme.com");
  assert.equal(enriched.workEmail, "jane.vandoe@acme.com");
  assert.equal(enriched.displayName, "Jane Van Doe");
});

test("deriveIdentity falls back to a default pattern and yields no UPN without a domain", () => {
  const { payload } = normalizeIntake(onboard);
  const noDomain = deriveIdentity(payload, { usernamePatterns: null, primaryDomain: null });
  assert.equal(noDomain.userPrincipalName, null);
  assert.equal(noDomain.samAccountName, "jane.vandoe"); // default {first}.{last}
});

test("emailTemplateFields fills the .eml variable labels from the payload", () => {
  const { payload } = normalizeIntake(onboard);
  const enriched = deriveIdentity(payload, { usernamePatterns: ["{first}{last}@{domain}"], primaryDomain: "acme.com" });
  const f = emailTemplateFields(enriched);
  assert.equal(f["Name"], "Jane Van Doe");
  assert.equal(f["Title"], "Analyst");
  assert.equal(f["Department"], "Finance");
  assert.equal(f["Location"], "United States");
  assert.equal(f["Reports to"], "Evan Kent");
  assert.equal(f["Start Date"], "2026-07-06");
  assert.equal(f["Personal Email"], "jane.personal@gmail.com");
  assert.equal(f["Work Email"], "janevandoe@acme.com");
});
