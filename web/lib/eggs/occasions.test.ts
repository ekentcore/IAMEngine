import { test } from "node:test";
import assert from "node:assert/strict";
import { occasionsFor, isMilestoneCase, isClientsListPath } from "./occasions";

function bannerOfKind(date: string, kind: string) {
  return occasionsFor(date).banners.find((b) => b.kind === kind) ?? null;
}

// ---- Birthday banner (Nov 14; Sat -> also Nov 13 "TOMORROW"; Sun -> also Nov 15 "BELATED") ----

test("birthday: Nov 14 always shows the main message", () => {
  for (const d of ["2026-11-14", "2027-11-14", "2028-11-14"]) {
    assert.deepEqual(bannerOfKind(d, "birthday"), {
      kind: "birthday",
      message: "HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT",
    });
  }
});

test("birthday on a Saturday (2026): Nov 13 shows TOMORROW variant", () => {
  assert.deepEqual(bannerOfKind("2026-11-13", "birthday"), {
    kind: "birthday",
    message: "HAPPY BIRTHDAY TOMORROW TO MY CREATOR - EVAN KENT",
  });
  assert.equal(bannerOfKind("2026-11-15", "birthday"), null); // Sunday after a Saturday birthday: nothing
});

test("birthday on a Sunday (2027): Nov 15 shows BELATED variant", () => {
  assert.deepEqual(bannerOfKind("2027-11-15", "birthday"), {
    kind: "birthday",
    message: "HAPPY BELATED BIRTHDAY TO MY CREATOR - EVAN KENT",
  });
  assert.equal(bannerOfKind("2027-11-13", "birthday"), null); // Saturday before a Sunday birthday: nothing
});

test("birthday on a weekday (2028, Tuesday): 13th and 15th show nothing", () => {
  assert.equal(bannerOfKind("2028-11-13", "birthday"), null);
  assert.equal(bannerOfKind("2028-11-15", "birthday"), null);
});

// ---- Holiday-eve banner ----
// Rules: holiday Tue-Fri -> show previous day; Sat -> show Thursday; Sun -> show Friday; Mon -> show Friday.

test("Thanksgiving 2026 (Thu Nov 26): eve shows Wed Nov 25", () => {
  assert.deepEqual(bannerOfKind("2026-11-25", "holiday-eve"), {
    kind: "holiday-eve",
    message: "I HOPE YOU HAVE TOMORROW OFF FOR THANKSGIVING",
  });
  assert.equal(bannerOfKind("2026-11-24", "holiday-eve"), null);
});

test("July 4 2026 is a Saturday: eve shows Thursday July 2", () => {
  assert.deepEqual(bannerOfKind("2026-07-02", "holiday-eve"), {
    kind: "holiday-eve",
    message: "I HOPE YOU HAVE TOMORROW OFF FOR INDEPENDENCE DAY",
  });
  assert.equal(bannerOfKind("2026-07-03", "holiday-eve"), null); // Friday assumed observed off
});

test("July 4 2027 is a Sunday: eve shows Friday July 2", () => {
  assert.equal(bannerOfKind("2027-07-02", "holiday-eve")?.message, "I HOPE YOU HAVE TOMORROW OFF FOR INDEPENDENCE DAY");
  assert.equal(bannerOfKind("2027-07-03", "holiday-eve"), null);
});

test("Memorial Day 2027 (Mon May 31): eve shows Friday May 28", () => {
  assert.equal(bannerOfKind("2027-05-28", "holiday-eve")?.message, "I HOPE YOU HAVE TOMORROW OFF FOR MEMORIAL DAY");
  assert.equal(bannerOfKind("2027-05-30", "holiday-eve"), null);
});

test("Christmas 2026 (Fri Dec 25): eve shows Thursday Dec 24", () => {
  assert.equal(bannerOfKind("2026-12-24", "holiday-eve")?.message, "I HOPE YOU HAVE TOMORROW OFF FOR CHRISTMAS");
});

test("New Year's Day 2028 (Sat Jan 1): eve shows Thursday Dec 30 2027 (crosses the year boundary)", () => {
  assert.equal(bannerOfKind("2027-12-30", "holiday-eve")?.message, "I HOPE YOU HAVE TOMORROW OFF FOR NEW YEAR'S DAY");
});

test("an ordinary day has no banner", () => {
  assert.deepEqual(occasionsFor("2026-07-24").banners, []);
});

// ---- Stacking ----

test("a greeting and an eve banner stack for real (Dec 31 2026: New Year's eve + Kwanzaa)", () => {
  const banners = occasionsFor("2026-12-31").banners;
  assert.ok(banners.some((b) => b.kind === "holiday-eve" && b.message === "I HOPE YOU HAVE TOMORROW OFF FOR NEW YEAR'S DAY"));
  assert.ok(banners.some((b) => b.kind === "greeting" && b.message === "JOYOUS KWANZAA"));
});

test("birthday stacks first when a greeting shares the day", () => {
  const banners = occasionsFor("2026-11-14").banners;
  assert.equal(banners[0].kind, "birthday");
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

// ---- Anniversary (March 22) ----

test("anniversary is true only on March 22, any year", () => {
  assert.equal(occasionsFor("2027-03-22").anniversary, true);
  assert.equal(occasionsFor("2031-03-22").anniversary, true);
  assert.equal(occasionsFor("2027-03-21").anniversary, false);
  assert.equal(occasionsFor("2027-03-23").anniversary, false);
  assert.equal(occasionsFor("2027-02-22").anniversary, false);
});

test("isClientsListPath: the three list routes, not detail/review/other pages", () => {
  assert.equal(isClientsListPath("/clients"), true);
  assert.equal(isClientsListPath("/clients/v2"), true);
  assert.equal(isClientsListPath("/clients/v3"), true);
  assert.equal(isClientsListPath("/clients/acme-co"), false);
  assert.equal(isClientsListPath("/clients/review"), false);
  assert.equal(isClientsListPath("/cases"), false);
  assert.equal(isClientsListPath(null), false);
  assert.equal(isClientsListPath(undefined), false);
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
