import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANGELOG, formatChangelogTime, formatChangelogWhen, isQuarterHour } from "./entries";

// The day the `time` field landed. Anything shipped on or after it must carry a time — the older
// entries were written before times were recorded, and are left date-only rather than invented.
const TIMES_REQUIRED_FROM = "2026-07-13";

// Sort key for "newest first": a timeless entry sorts to the start of its day, below that day's
// timed entries — which is where the backfill actually left them.
const when = (e: { date: string; time?: string }) => `${e.date} ${e.time ?? "00:00"}`;

test("change-log entries are well-formed (unique ids, valid dates, newest first, non-empty items)", () => {
  assert.ok(CHANGELOG.length > 0);
  const ids = new Set<string>();
  let prev: string | null = null;
  for (const e of CHANGELOG) {
    assert.ok(e.id && !ids.has(e.id), `duplicate/empty id: ${e.id}`);
    ids.add(e.id);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `bad date on ${e.id}`);
    assert.ok(!Number.isNaN(new Date(e.date).getTime()), `unparseable date on ${e.id}`);
    assert.ok(e.title.trim().length > 0, `empty title on ${e.id}`);
    assert.ok(e.items.length > 0 && e.items.every((i) => i.trim().length > 0), `empty items on ${e.id}`);
    // Bullets go to chat verbatim as single lines.
    assert.ok(e.items.every((i) => !i.includes("\n")), `multiline item on ${e.id}`);
    if (prev) assert.ok(when(e) <= prev, `entries out of order at ${e.id} (newest must be first)`);
    prev = when(e);
  }
});

test("ship times are quarter-hours, and every entry from 2026-07-13 on has one", () => {
  for (const e of CHANGELOG) {
    if (e.time !== undefined) {
      assert.ok(isQuarterHour(e.time), `time on ${e.id} is not on a 15-minute boundary: ${e.time}`);
    } else {
      assert.ok(e.date < TIMES_REQUIRED_FROM, `entry ${e.id} (${e.date}) needs a time — add one, on the quarter hour`);
    }
  }
});

test("times render as a 12-hour wall clock (no time-zone shift)", () => {
  assert.equal(formatChangelogTime("00:00"), "12:00 am");
  assert.equal(formatChangelogTime("00:15"), "12:15 am");
  assert.equal(formatChangelogTime("09:30"), "9:30 am");
  assert.equal(formatChangelogTime("12:00"), "12:00 pm");
  assert.equal(formatChangelogTime("13:45"), "1:45 pm");
  assert.equal(formatChangelogTime("23:00"), "11:00 pm");
});

test("a malformed time is echoed back, never formatted into nonsense", () => {
  // This string reaches the customer chat channels; "NaN:undefined pm" must never be sendable.
  for (const bad of ["banana", "16", "16:3o", "16:30:00"]) {
    assert.equal(formatChangelogTime(bad), bad, `should echo ${JSON.stringify(bad)} unchanged`);
  }
});

test("isQuarterHour rejects off-boundary and malformed times", () => {
  for (const bad of ["22:46", "9:00", "24:00", "22:60", "22", "", "10:15 pm"]) {
    assert.equal(isQuarterHour(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ["00:00", "16:30", "23:45"]) assert.equal(isQuarterHour(ok), true, `should accept ${ok}`);
});

test("formatChangelogWhen carries date, time, and the approx flag", () => {
  const base = { id: "x", title: "t", items: ["i"] };
  assert.equal(formatChangelogWhen({ ...base, date: "2026-07-13", time: "16:30" }), "2026-07-13 4:30 pm");
  assert.equal(formatChangelogWhen({ ...base, date: "2026-07-13" }), "2026-07-13");
  assert.equal(formatChangelogWhen({ ...base, date: "2026-05-28", approx: true }), "2026-05-28 (approx.)");
  assert.equal(formatChangelogWhen({ ...base, date: "2026-05-28", time: "09:00", approx: true }), "2026-05-28 9:00 am (approx.)");
});
