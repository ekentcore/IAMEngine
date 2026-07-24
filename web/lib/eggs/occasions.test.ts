import { test } from "node:test";
import assert from "node:assert/strict";
import { occasionsFor, isMilestoneCase } from "./occasions";

// ---- Birthday banner (Nov 14; Sat -> also Nov 13 "TOMORROW"; Sun -> also Nov 15 "BELATED") ----

test("birthday: Nov 14 always shows the main message", () => {
  for (const d of ["2026-11-14", "2027-11-14", "2028-11-14"]) {
    assert.deepEqual(occasionsFor(d).banner, {
      kind: "birthday",
      message: "HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT",
    });
  }
});

test("birthday on a Saturday (2026): Nov 13 shows TOMORROW variant", () => {
  assert.deepEqual(occasionsFor("2026-11-13").banner, {
    kind: "birthday",
    message: "HAPPY BIRTHDAY TOMORROW TO MY CREATOR - EVAN KENT",
  });
  assert.equal(occasionsFor("2026-11-15").banner, null); // Sunday after a Saturday birthday: nothing
});

test("birthday on a Sunday (2027): Nov 15 shows BELATED variant", () => {
  assert.deepEqual(occasionsFor("2027-11-15").banner, {
    kind: "birthday",
    message: "HAPPY BELATED BIRTHDAY TO MY CREATOR - EVAN KENT",
  });
  assert.equal(occasionsFor("2027-11-13").banner, null); // Saturday before a Sunday birthday: nothing
});

test("birthday on a weekday (2028, Tuesday): 13th and 15th show nothing", () => {
  assert.equal(occasionsFor("2028-11-13").banner, null);
  assert.equal(occasionsFor("2028-11-15").banner, null);
});

// ---- Holiday-eve banner ----
// Rules: holiday Tue-Fri -> show previous day; Sat -> show Thursday; Sun -> show Friday; Mon -> show Friday.

test("Thanksgiving 2026 (Thu Nov 26): eve shows Wed Nov 25", () => {
  assert.deepEqual(occasionsFor("2026-11-25").banner, {
    kind: "holiday-eve",
    message: "I HOPE YOU HAVE TOMORROW OFF FOR THANKSGIVING",
  });
  assert.equal(occasionsFor("2026-11-24").banner, null);
});

test("July 4 2026 is a Saturday: eve shows Thursday July 2", () => {
  assert.deepEqual(occasionsFor("2026-07-02").banner, {
    kind: "holiday-eve",
    message: "I HOPE YOU HAVE TOMORROW OFF FOR INDEPENDENCE DAY",
  });
  assert.equal(occasionsFor("2026-07-03").banner, null); // Friday assumed observed off
});

test("July 4 2027 is a Sunday: eve shows Friday July 2", () => {
  assert.equal(occasionsFor("2027-07-02").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR INDEPENDENCE DAY");
  assert.equal(occasionsFor("2027-07-03").banner, null);
});

test("Memorial Day 2027 (Mon May 31): eve shows Friday May 28", () => {
  assert.equal(occasionsFor("2027-05-28").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR MEMORIAL DAY");
  assert.equal(occasionsFor("2027-05-30").banner, null);
});

test("Christmas 2026 (Fri Dec 25): eve shows Thursday Dec 24", () => {
  assert.equal(occasionsFor("2026-12-24").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR CHRISTMAS");
});

test("New Year's Day 2028 (Sat Jan 1): eve shows Thursday Dec 30 2027 (crosses the year boundary)", () => {
  assert.equal(occasionsFor("2027-12-30").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR NEW YEAR'S DAY");
});

test("an ordinary day has no banner", () => {
  assert.equal(occasionsFor("2026-07-24").banner, null);
});

// ---- Bulb glyph ----

test("bulb glyph windows", () => {
  assert.equal(occasionsFor("2026-10-25").bulbGlyph, "🎃");
  assert.equal(occasionsFor("2026-10-31").bulbGlyph, "🎃");
  assert.equal(occasionsFor("2026-10-24").bulbGlyph, "💡");
  assert.equal(occasionsFor("2026-12-20").bulbGlyph, "🎄");
  assert.equal(occasionsFor("2026-12-26").bulbGlyph, "🎄");
  assert.equal(occasionsFor("2026-12-31").bulbGlyph, "🎆");
  assert.equal(occasionsFor("2027-01-01").bulbGlyph, "🎆");
  assert.equal(occasionsFor("2026-07-24").bulbGlyph, "💡");
});

// ---- New Year window ----

test("newYear is true only Jan 1-2", () => {
  assert.equal(occasionsFor("2027-01-01").newYear, true);
  assert.equal(occasionsFor("2027-01-02").newYear, true);
  assert.equal(occasionsFor("2027-01-03").newYear, false);
});

// ---- Milestone case ----

test("isMilestoneCase: trailing number multiple of 1000", () => {
  assert.equal(isMilestoneCase("IAM0001000"), true);
  assert.equal(isMilestoneCase("UM0030000"), true);
  assert.equal(isMilestoneCase("IAM0001001"), false);
  assert.equal(isMilestoneCase("UM0029763"), false);
  assert.equal(isMilestoneCase("IAM0000000"), false); // zero is not a milestone
  assert.equal(isMilestoneCase(null), false);
  assert.equal(isMilestoneCase(undefined), false);
  assert.equal(isMilestoneCase("no-digits"), false);
});
