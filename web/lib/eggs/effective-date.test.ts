import { test } from "node:test";
import assert from "node:assert/strict";
import { todayEastern, effectiveEggDate } from "./effective-date";

test("todayEastern formats the Eastern calendar date, not UTC", () => {
  // 02:00 UTC on Jul 25 is still 22:00 Jul 24 in New York (EDT, UTC-4).
  assert.equal(todayEastern(new Date("2026-07-25T02:00:00Z")), "2026-07-24");
  assert.equal(todayEastern(new Date("2026-07-24T12:00:00-04:00")), "2026-07-24");
  // Winter (EST, UTC-5): 04:30 UTC Jan 2 is 23:30 Jan 1 in New York.
  assert.equal(todayEastern(new Date("2027-01-02T04:30:00Z")), "2027-01-01");
});

test("simulated date is honored only for a super admin", () => {
  const now = new Date("2026-07-24T12:00:00-04:00");
  assert.equal(effectiveEggDate("2026-11-14", true, now), "2026-11-14");
  assert.equal(effectiveEggDate("2026-11-14", false, now), "2026-07-24");
  assert.equal(effectiveEggDate(undefined, true, now), "2026-07-24");
});

test("garbage cookie values are ignored", () => {
  const now = new Date("2026-07-24T12:00:00-04:00");
  assert.equal(effectiveEggDate("not-a-date", true, now), "2026-07-24");
  assert.equal(effectiveEggDate("2026-13-40", true, now), "2026-07-24"); // not a real calendar date
  assert.equal(effectiveEggDate("2026-02-30", true, now), "2026-07-24"); // Feb 30 would roll over
  assert.equal(effectiveEggDate("", true, now), "2026-07-24");
});
