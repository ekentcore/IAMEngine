import { test } from "node:test";
import assert from "node:assert/strict";
import { greetingsFor, easterFor } from "./greetings";
import { HOLIDAY_TABLE } from "./holiday-dates";
import { ymd } from "./date-math";

function messages(date: string): string[] {
  return greetingsFor(date).map((b) => b.message);
}

test("computed US holidays greet on the day with exact copy", () => {
  assert.ok(messages("2026-11-26").includes("HAPPY THANKSGIVING TO YOU AND YOUR FAMILY"));
  assert.ok(messages("2026-12-25").includes("MERRY CHRISTMAS TO ALL"));
  assert.ok(messages("2027-01-01").includes("WISHING YOU A HAPPY AND HEALTHY NEW YEAR"));
  assert.ok(messages("2026-07-04").includes("HAPPY INDEPENDENCE DAY"));
  assert.ok(messages("2026-09-07").includes("HAPPY LABOR DAY")); // first Mon Sep 2026
});

test("Memorial Day is solemn, no emoji, respectful copy", () => {
  const g = greetingsFor("2026-05-25").find((b) => b.message.includes("MEMORIAL")); // last Mon May 2026
  assert.ok(g);
  assert.equal(g!.message, "REMEMBERING THOSE WHO SERVED THIS MEMORIAL DAY");
  assert.equal(g!.solemn, true);
  assert.equal(g!.emoji, undefined);
});

test("Kwanzaa spans Dec 26 through Jan 1 (crosses the year)", () => {
  assert.ok(messages("2026-12-26").includes("JOYOUS KWANZAA"));
  assert.ok(messages("2027-01-01").includes("JOYOUS KWANZAA"));
  assert.ok(!messages("2027-01-02").includes("JOYOUS KWANZAA"));
});

test("Easter computus matches verified dates", () => {
  // Verified via WebSearch 2026-07-24: Apr 5 2026, Mar 28 2027, Apr 16 2028.
  assert.equal(ymd(easterFor(2026)), "2026-04-05");
  assert.equal(ymd(easterFor(2027)), "2027-03-28");
  assert.equal(ymd(easterFor(2028)), "2028-04-16");
  assert.ok(messages(ymd(easterFor(2026))).includes("HAPPY EASTER"));
});

test("table-driven holidays greet across their whole span", () => {
  for (const [key, expected] of [
    ["roshHashanah", "SHANAH TOVAH — WISHING YOU A SWEET NEW YEAR"],
    ["hanukkah", "HAPPY HANUKKAH"],
    ["passover", "CHAG PESACH SAMEACH — HAPPY PASSOVER"],
    ["ramadan", "RAMADAN MUBARAK"],
    ["eidAlFitr", "EID MUBARAK TO YOU AND YOUR FAMILY"],
    ["eidAlAdha", "EID MUBARAK TO YOU AND YOUR FAMILY"],
    ["lunarNewYear", "HAPPY LUNAR NEW YEAR"],
    ["diwali", "HAPPY DIWALI — FESTIVAL OF LIGHTS"],
  ] as const) {
    for (const span of HOLIDAY_TABLE[key]) {
      assert.ok(messages(span.start).includes(expected), `${key} ${span.start} first day`);
      // last day of the span still greets; the day after does not
      const last = new Date(span.start + "T12:00:00");
      last.setDate(last.getDate() + span.days - 1);
      const after = new Date(last); after.setDate(after.getDate() + 1);
      const pad = (n: number) => String(n).padStart(2, "0");
      const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      assert.ok(messages(iso(last)).includes(expected), `${key} ${span.start} last day`);
      assert.ok(!messages(iso(after)).includes(expected), `${key} ${span.start} day after`);
    }
  }
});

test("Yom Kippur is solemn with respectful copy", () => {
  const day = HOLIDAY_TABLE.yomKippur[0].start;
  const g = greetingsFor(day).find((b) => b.solemn);
  assert.ok(g);
  assert.equal(g!.message, "WISHING YOU AN EASY AND MEANINGFUL FAST — G'MAR CHATIMA TOVA");
});

test("greetings stack on overlap days (Christmas inside a Hanukkah span, when the table has one)", () => {
  const overlapping = HOLIDAY_TABLE.hanukkah.find((s) => {
    const y = Number(s.start.slice(0, 4));
    return greetingsFor(`${y}-12-25`).some((b) => b.message === "HAPPY HANUKKAH");
  });
  if (overlapping) {
    const y = Number(overlapping.start.slice(0, 4));
    const msgs = messages(`${y}-12-25`);
    assert.ok(msgs.includes("MERRY CHRISTMAS TO ALL") && msgs.includes("HAPPY HANUKKAH"));
  } // if no overlap year exists in 2026-2032, this test passes vacuously — note it in the report
});

test("an ordinary day has no greetings", () => {
  assert.deepEqual(greetingsFor("2026-08-11"), []);
});

test("all greetings carry kind greeting", () => {
  for (const b of greetingsFor("2026-12-25")) assert.equal(b.kind, "greeting");
});
