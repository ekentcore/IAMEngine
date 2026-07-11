import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultScheduleFor, subtractBusinessDays, caseEffectiveDate } from "./schedule";

// A "now" far before every fixture date so the past-guard doesn't interfere.
const NOW = new Date(2026, 0, 1, 12, 0);
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

// --- subtractBusinessDays -------------------------------------------------

test("business days: Monday minus 3 lands on the previous Wednesday", () => {
  // Mon 2026-07-13 → Fri 10, Thu 9, Wed 8
  assert.deepEqual(subtractBusinessDays(local(2026, 7, 13, 8), 3), local(2026, 7, 8, 8));
});

test("business days: mid-week span with no weekend just steps back", () => {
  // Fri 2026-07-17 → Thu 16, Wed 15, Tue 14
  assert.deepEqual(subtractBusinessDays(local(2026, 7, 17, 8), 3), local(2026, 7, 14, 8));
});

test("business days: crosses a month boundary and a weekend", () => {
  // Wed 2026-07-01 → Tue Jun 30, Mon Jun 29, (skip Sun 28 / Sat 27) Fri Jun 26
  assert.deepEqual(subtractBusinessDays(local(2026, 7, 1, 8), 3), local(2026, 6, 26, 8));
});

test("business days: a weekend start date counts only weekdays stepped over", () => {
  // Sat 2026-07-18 → Fri 17, Thu 16, Wed 15
  assert.deepEqual(subtractBusinessDays(local(2026, 7, 18, 8), 3), local(2026, 7, 15, 8));
});

// --- defaultScheduleFor: offboard ------------------------------------------

test("offboard: date-only means 17:00 local + 5 minutes", () => {
  assert.deepEqual(defaultScheduleFor("offboard", "2026-07-20", NOW), local(2026, 7, 20, 17, 5));
});

test("offboard: an intake datetime keeps its time (+5 min)", () => {
  assert.deepEqual(defaultScheduleFor("offboard", "2026-07-20 09:30:00", NOW), local(2026, 7, 20, 9, 35));
});

test("offboard: +5 minutes rolls across the hour", () => {
  assert.deepEqual(defaultScheduleFor("offboard", "2026-07-20T17:58", NOW), local(2026, 7, 20, 18, 3));
});

test("offboard: MM/DD/YYYY (subject-derived) parses as a local date", () => {
  assert.deepEqual(defaultScheduleFor("offboard", "07/20/2026", NOW), local(2026, 7, 20, 17, 5));
});

// --- defaultScheduleFor: onboard --------------------------------------------

test("onboard: start date at 08:00 minus 3 business days", () => {
  // Start Mon 2026-07-13 → Wed 2026-07-08 08:00
  assert.deepEqual(defaultScheduleFor("onboard", "2026-07-13", NOW), local(2026, 7, 8, 8, 0));
});

test("onboard: month-boundary start date", () => {
  // Start Wed 2026-07-01 → Fri 2026-06-26 08:00
  assert.deepEqual(defaultScheduleFor("onboard", "2026-07-01", NOW), local(2026, 6, 26, 8, 0));
});

// --- past / missing / malformed ---------------------------------------------

test("null effective date → null", () => {
  assert.equal(defaultScheduleFor("offboard", null, NOW), null);
});

test("unparsable date → null", () => {
  assert.equal(defaultScheduleFor("offboard", "Immediate", NOW), null);
  assert.equal(defaultScheduleFor("onboard", "next Tuesday", NOW), null);
});

test("a suggestion in the past → null (caller falls back to now+1h)", () => {
  const now = new Date(2026, 6, 21, 12, 0); // after the 7/20 17:05 suggestion
  assert.equal(defaultScheduleFor("offboard", "2026-07-20", now), null);
  // Onboard: start date is future but 3 business days before it is already past.
  const now2 = new Date(2026, 6, 10, 12, 0);
  assert.equal(defaultScheduleFor("onboard", "2026-07-13", now2), null);
});

test("a suggestion exactly at now → null (must be strictly future)", () => {
  const at = local(2026, 7, 20, 17, 5);
  assert.equal(defaultScheduleFor("offboard", "2026-07-20", at), null);
});

// --- caseEffectiveDate --------------------------------------------------------

test("effective date: offboard prefers dateOfOffboarding, accepts legacy endDate", () => {
  assert.equal(caseEffectiveDate("offboard", { dateOfOffboarding: "2026-07-20" }, null), "2026-07-20");
  assert.equal(caseEffectiveDate("offboard", { endDate: "2026-07-21" }, null), "2026-07-21");
});

test("effective date: offboard falls back to an MM/DD/YYYY in the subject", () => {
  assert.equal(caseEffectiveDate("offboard", {}, "Offboarding - Ryan McNulty - 06/19/2026"), "2026-06-19");
  assert.equal(caseEffectiveDate("offboard", {}, "Offboarding - Immediate"), null);
});

test("effective date: onboard reads startDate only", () => {
  assert.equal(caseEffectiveDate("onboard", { startDate: "2026-07-13" }, null), "2026-07-13");
  assert.equal(caseEffectiveDate("onboard", {}, "Onboarding - 06/19/2026"), null);
});
