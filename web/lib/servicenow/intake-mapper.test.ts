import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntake, deriveIdentity, emailTemplateFields, applyUsernamePattern, umIntakeAction } from "./intake-mapper";
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

test("umIntakeAction: lifecycle subcategories map; non-lifecycle (Computer Build 30300) is skipped", () => {
  assert.equal(umIntakeAction(rec({ number: "UM1", subcategory: "30000" })), "onboard");
  assert.equal(umIntakeAction(rec({ number: "UM2", subcategory: "30100" })), "offboard");
  // Computer Build is a hardware request, NOT a user lifecycle case — must not import as a bogus onboard.
  assert.equal(umIntakeAction(rec({ number: "UM3", subcategory: ["30300", "Computer Build"], short_description: "Computer Request - Pat" })), null);
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

test("manager/mirror resolve to the customer_contact email (stable across SNOW/365), else the name", () => {
  const r = rec({
    number: "UM2", subcategory: "30000", u_first: "Jane", u_last: "Doe",
    u_manager_name: ["mgr-sys-id", "James (Jim) Goodmiller"],
    u_mirror_existing_user: ["mir-sys-id", "Bob (Bobby) Smith"],
    // fetchUserManagementCase stashes resolved emails here:
    "__email:u_manager_name": "jim.goodmiller@acme.com",
  });
  const { payload } = normalizeIntake(r);
  assert.equal(payload.managerName, "James (Jim) Goodmiller"); // display name kept
  assert.equal(payload.managerEmail, "jim.goodmiller@acme.com"); // resolved email preferred for lookup
  // the mirror had no resolved email -> falls back to the display name
  assert.equal(payload.mirrorPermissionsFromUser, "Bob (Bobby) Smith");
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

test("deriveIdentity drops a fallback whose tokens resolve empty (no '{first}.{mi}' -> 'felix.')", () => {
  // The bug: no middle initial made "{first}.{mi}" yield "felix." -> Entra rejects the UPN/mailNickname.
  const withMi = deriveIdentity({ firstName: "Felix", lastName: "Kessler", mi: "" }, {
    usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], primaryDomain: "drakestar.com",
  });
  assert.equal(withMi.userPrincipalName, "felix.kessler@drakestar.com");
  assert.equal(withMi.mailNickname, "felix.kessler");
  assert.deepEqual(withMi.userPrincipalNameFallbacks, []); // the "{first}.{mi}" fallback is unusable -> dropped

  // When a middle initial IS present, the fallback is kept and well-formed.
  const okMi = deriveIdentity({ firstName: "Felix", lastName: "Kessler", mi: "J" }, {
    usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], primaryDomain: "drakestar.com",
  });
  assert.deepEqual(okMi.userPrincipalNameFallbacks, ["felix.j@drakestar.com"]);
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

test("deriveIdentity: a nickname becomes the effective first name (givenName, displayName, username tokens)", () => {
  const p = deriveIdentity(
    { firstName: "William", lastName: "Smith", nickname: "Bill", displayName: "William Smith" },
    { usernamePatterns: ["{firstInitial}{last}@{domain}"], primaryDomain: "acme.com" }
  );
  // Bill Smith -> BSmith, not WSmith.
  assert.equal(p.samAccountName, "bsmith");
  assert.equal(p.userPrincipalName, "bsmith@acme.com");
  assert.equal(p.mailNickname, "bsmith");
  // The runner writes payload.firstName to AD givenName / Graph GivenName — it must carry the nickname.
  assert.equal(p.firstName, "Bill");
  assert.equal(p.legalFirstName, "William");
  // The intake-built displayName was assembled from the legal first — recomputed from the nickname.
  assert.equal(p.displayName, "Bill Smith");
});

test("deriveIdentity: no nickname leaves the legal first name in charge (and adds no legalFirstName)", () => {
  const p = deriveIdentity(
    { firstName: "William", lastName: "Smith", nickname: "", displayName: "William Smith" },
    { usernamePatterns: ["{firstInitial}{last}@{domain}"], primaryDomain: "acme.com" }
  );
  assert.equal(p.samAccountName, "wsmith");
  assert.equal(p.firstName, "William");
  assert.equal(p.displayName, "William Smith");
  assert.equal("legalFirstName" in p, false);
});

test("deriveIdentity: nickname derivation is idempotent across re-plans", () => {
  const once = deriveIdentity(
    { firstName: "William", lastName: "Smith", nickname: "Bill" },
    { usernamePatterns: ["{firstInitial}{last}@{domain}"], primaryDomain: "acme.com" }
  );
  // Re-plan re-derives over the already-derived payload (firstName now "Bill") — the preserved
  // legalFirstName must survive, not get clobbered by the overridden firstName.
  const twice = deriveIdentity(once, { usernamePatterns: ["{firstInitial}{last}@{domain}"], primaryDomain: "acme.com" });
  assert.equal(twice.firstName, "Bill");
  assert.equal(twice.legalFirstName, "William");
  assert.equal(twice.samAccountName, "bsmith");
});

test("deriveIdentity: clearing a nickname reverts firstName/displayName/sam to the legal name", () => {
  const opts = { usernamePatterns: ["{firstInitial}{last}@{domain}"], primaryDomain: "acme.com" };
  const once = deriveIdentity({ firstName: "William", lastName: "Smith", nickname: "Bill" }, opts);
  // The nickname is emptied on the stored (already-derived) payload — e.g. a payload edit without a
  // full ServiceNow refresh. Everything must revert, not leave firstName stuck on "Bill".
  const cleared = deriveIdentity({ ...once, nickname: "" }, opts);
  assert.equal(cleared.firstName, "William");
  assert.equal(cleared.displayName, "William Smith");
  assert.equal(cleared.samAccountName, "wsmith");
});

test("deriveIdentity: an operator-edited displayName survives re-derivation even with a nickname", () => {
  const opts = { usernamePatterns: ["{firstInitial}{last}@{domain}"], primaryDomain: "acme.com" };
  const p = deriveIdentity(
    { firstName: "William", lastName: "Smith", nickname: "Bill", displayName: "Bill Smith Jr.", fieldSource: { displayName: "operator" } },
    opts
  );
  assert.equal(p.displayName, "Bill Smith Jr."); // operator provenance wins over the nickname recompute
  assert.equal(p.samAccountName, "bsmith"); // username derivation still nickname-based
});

test("deriveIdentity: nickname feeds {first} fallback patterns too", () => {
  const p = deriveIdentity(
    { firstName: "William", lastName: "Smith", nickname: "Bill", mi: "J" },
    { usernamePatterns: ["{firstInitial}{last}@{domain}", "{first}.{mi}@{domain}"], primaryDomain: "acme.com" }
  );
  assert.deepEqual(p.userPrincipalNameFallbacks, ["bill.j@acme.com"]);
});

test("deriveIdentity derives fallback UPNs from extra username patterns", () => {
  const p = deriveIdentity(
    { firstName: "Jane", lastName: "Doe", mi: "M" },
    { usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], primaryDomain: "drakestar.com" }
  );
  assert.equal(p.userPrincipalName, "jane.doe@drakestar.com");
  assert.deepEqual(p.userPrincipalNameFallbacks, ["jane.m@drakestar.com"]);
});

test("deriveIdentity yields no fallbacks when only one pattern is set", () => {
  const p = deriveIdentity(
    { firstName: "Jane", lastName: "Doe" },
    { usernamePatterns: ["{first}.{last}@{domain}"], primaryDomain: "x.com" }
  );
  assert.deepEqual(p.userPrincipalNameFallbacks, []);
});

test("offboard forwardEmailTo: readable label + sys_id in parens (not a bare sys_id)", () => {
  const id = "65230413c30c4f50f8ee242bb0013104";
  // email resolved from customer_contact -> "email (sys_id)"
  const withEmail = normalizeIntake(rec({
    number: "UM0029643", subcategory: "30100",
    u_forward_email_to: [id, "Andrew Cohen"],
    "__email:u_forward_email_to": "acohen@x.com",
  })).payload as Record<string, unknown>;
  assert.equal(withEmail.forwardEmailTo, `acohen@x.com (${id})`);

  // no email resolved but a real display name -> "name (sys_id)"
  const withName = normalizeIntake(rec({
    number: "UM2", subcategory: "30100", u_forward_email_to: ["sysid123", "Andrew Cohen"],
  })).payload as Record<string, unknown>;
  assert.equal(withName.forwardEmailTo, "Andrew Cohen (sysid123)");

  // display_value IS the sys_id (unresolved reference), no email -> the bare sys_id, no "(id)" dupe
  const bare = normalizeIntake(rec({
    number: "UM3", subcategory: "30100", u_forward_email_to: "sysidonly",
  })).payload as Record<string, unknown>;
  assert.equal(bare.forwardEmailTo, "sysidonly");
});
