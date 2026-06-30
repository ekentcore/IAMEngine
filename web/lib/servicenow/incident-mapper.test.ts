import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIncidentIntake, extractMirrorUser } from "./incident-mapper";
import { incidentAction } from "./incident-intake";

// Flat record with dotted variable keys, exactly as the Table API returns it for INC0836187.
const fv = (value: string, display?: string) => ({ value, display_value: display ?? value });
const AVNI = {
  number: fv("INC0836187"),
  short_description: fv("Onboarding - 06/15/2026 - Avni Anand"),
  subcategory: fv("user_onboarding", "User / On-Boarding"),
  company: fv("d8d9...sysid", "Coretelligent"),
  opened_by: fv("smoore", "Sammi Moore"),
  "variables.u_first_name": fv("Avni"),
  "variables.u_last_name": fv("Anand"),
  "variables.u_personal_email": fv("avnianand20@gmail.com"),
  "variables.u_phone_number": fv(""),
  "variables.u_workspace_location": fv("remote_us", "Remote (US)"),
  "variables.u_office_location": fv(""),
  "variables.u_department": fv("Finance"),
  "variables.u_hiring_manager": fv("c29d5ebd835bc214", "Samantha Ross"),
  "variables.u_title": fv("Senior Finance & Business Intelligence Analyst"),
  "variables.u_start_date": fv("06/15/2026"),
  "variables.u_employment_type": fv("fte", "Full-Time Employee"),
  "variables.u_equip_amex": fv("No"),
  "variables.u_shipping": fv("138 Elmerston Rd. Rochester, NY 14620. Avni requires a monitor, keyboard, mouse and docking station. Please have her permissions/access mirror Christine Holleran. Thank you!"),
};

test("normalizeIncidentIntake: maps Avni's variables to the onboard payload", () => {
  const intake = normalizeIncidentIntake(AVNI as never);
  assert.equal(intake.action, "onboard");
  assert.equal(intake.caseNumber, "INC0836187");
  assert.equal(intake.clientSysId, "d8d9...sysid");
  assert.match(intake.subject, /Avni Anand/);

  const p = intake.payload;
  assert.equal(p.firstName, "Avni");
  assert.equal(p.lastName, "Anand");
  assert.equal(p.jobTitle, "Senior Finance & Business Intelligence Analyst");
  assert.equal(p.title, "Senior Finance & Business Intelligence Analyst");
  assert.equal(p.department, "Finance");
  assert.equal(p.officeLocation, "Remote (US)"); // falls back to workspace location when office is blank
  assert.equal(p.employmentType, "Full-Time");   // "Full-Time Employee"/"fte" normalized
  assert.equal(p.managerName, "Samantha Ross");   // display value, not the sys_id
  assert.equal(p.startDate, "06/15/2026");
  assert.equal(p.personalEmail, "avnianand20@gmail.com");
  assert.equal(p.cellPhoneRequired, false);       // u_equip_amex "No"
  assert.equal(p.mirrorPermissionsFromUser, "Christine Holleran"); // parsed from the free-text shipping note
});

test("extractMirrorUser: pulls the reference user from free text, else null", () => {
  assert.equal(extractMirrorUser("please have her access mirror Christine Holleran. thanks"), "Christine Holleran");
  assert.equal(extractMirrorUser("mirror permissions of John Q Public"), "John Q Public");
  assert.equal(extractMirrorUser("no mirror directive here"), null);
  assert.equal(extractMirrorUser(""), null);
});

// An offboarding incident (different subcategory + the departing user's identity).
const OFFB = {
  number: fv("INC0844048"),
  short_description: fv("Offboarding - 06/30/2026 - Jordan Park"),
  subcategory: fv("user_offboarding", "User / Off-Boarding"),
  company: fv("d8d9...sysid", "Coretelligent"),
  opened_by: fv("smoore", "Sammi Moore"),
  "variables.u_first_name": fv("Jordan"),
  "variables.u_last_name": fv("Park"),
  "variables.u_email": fv("jordan.park@coretelligent.com"),
  "variables.u_department": fv("Sales", "Sales"),
  "variables.u_last_day": fv("06/30/2026"),
  "variables.u_computer_name": fv("LT-JPARK"),
};

test("normalizeIncidentIntake: routes an offboarding incident to the offboard payload", () => {
  const intake = normalizeIncidentIntake(OFFB as never);
  assert.equal(intake.action, "offboard");
  assert.equal(intake.caseNumber, "INC0844048");
  const p = intake.payload as Record<string, unknown>;
  assert.equal(p.userToOffboard, "Jordan Park");
  assert.equal(p.displayName, "Jordan Park");
  assert.equal(p.UserPrincipalName, "jordan.park@coretelligent.com");
  assert.equal(p.email, "jordan.park@coretelligent.com");
  assert.equal(p.department, "Sales");
  assert.equal(p.dateOfOffboarding, "06/30/2026");
  assert.equal(p.computerName, "LT-JPARK");
});

test("normalizeIncidentIntake: 'off-boarding' is not misread as onboarding", () => {
  assert.equal(normalizeIncidentIntake(OFFB as never).action, "offboard");
  assert.equal(normalizeIncidentIntake(AVNI as never).action, "onboard");
});

// Name only in the short description (no first/last variables on the form).
const OFFB_SD_ONLY = {
  number: fv("INC0844049"),
  short_description: fv("Offboarding - 06/30/2026 - Morgan Lee"),
  subcategory: fv("user_offboarding", "User / Off-Boarding"),
  company: fv("sysid", "Coretelligent"),
};

test("normalizeIncidentIntake: extracts the offboard user's name from the short description", () => {
  const p = normalizeIncidentIntake(OFFB_SD_ONLY as never).payload as Record<string, unknown>;
  assert.equal(p.displayName, "Morgan Lee");
  assert.equal(p.firstName, "Morgan");
  assert.equal(p.lastName, "Lee");
});

// Regression (INC0840775): title is "Offboarding - <Name> - Immediate" with NO name variables — the
// urgency word "Immediate" must not be mistaken for the first name.
const OFFB_IMMEDIATE = {
  number: fv("INC0840775"),
  short_description: fv("Offboarding - Neil Richter - Immediate"),
  subcategory: fv("user_offboarding", "User / Off-Boarding"),
  company: fv("sysid", "Coretelligent"),
};

test("normalizeIncidentIntake: '… - Immediate' is the timing, not the name", () => {
  const p = normalizeIncidentIntake(OFFB_IMMEDIATE as never).payload as Record<string, unknown>;
  assert.equal(p.displayName, "Neil Richter");
  assert.equal(p.firstName, "Neil");
  assert.equal(p.lastName, "Richter");
});

// "OFFB - <Name> - <date>" abbreviation variant — pick the person name, not the label/date.
const OFFB_ABBR = {
  number: fv("INC0840900"),
  short_description: fv("OFFB - Katie Butzer - 06/30"),
  subcategory: fv("user_offboarding", "User / Off-Boarding"),
  company: fv("sysid", "Coretelligent"),
};
test("normalizeIncidentIntake: 'OFFB - Name - date' picks the name", () => {
  const p = normalizeIncidentIntake(OFFB_ABBR as never).payload as Record<string, unknown>;
  assert.equal(p.displayName, "Katie Butzer");
});

// Regression (INC0850968): an internal onboard incident with NO producer variables — name and start
// date come from the title; the legal name sits on the notes' first line.
const ONB_NO_VARS = {
  number: fv("INC0850968"),
  short_description: fv("Onboarding - 07/13/2026 - Drew Dirienzo"),
  subcategory: fv("user_onboarding", "User / On-Boarding"),
  company: fv("sysid", "Coretelligent"),
  "variables.description": fv("Andrew Dirienzo\r\n74 S Transithill Dr.\r\nDepew, NY 14043"),
};
test("normalizeIncidentIntake: onboard with no variables pulls name + start date from the title", () => {
  const p = normalizeIncidentIntake(ONB_NO_VARS as never).payload as Record<string, unknown>;
  assert.equal(p.firstName, "Drew");
  assert.equal(p.lastName, "Dirienzo");
  assert.equal(p.displayName, "Drew Dirienzo");
  assert.equal(p.startDate, "07/13/2026");
});

// INC0233115: service/infrastructure deprovisioning reuses "Off-Boarding" wording but is NOT a user
// lifecycle case — incidentAction must return null so the poller skips it.
const SERVICE_DEPROV = {
  number: fv("INC0233115"),
  short_description: fv("Partial Deprovisioning / Off-boarding Request"),
  subcategory: fv("deprovisioning", "Deprovisioning"),
  u_producer: fv("Service Deprovisioning / Off-Boarding"),
  company: fv("sysid", "Cove Hill Partners"),
};
test("incidentAction: service deprovisioning is not a user lifecycle incident", () => {
  assert.equal(incidentAction(SERVICE_DEPROV as never), null);
  // sanity: genuine user incidents still detect
  assert.equal(incidentAction(AVNI as never), "onboard");
  assert.equal(incidentAction(OFFB as never), "offboard");
});
