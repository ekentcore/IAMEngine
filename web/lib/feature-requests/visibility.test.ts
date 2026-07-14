import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FR_HIDE_WINDOW_DAYS,
  frHideAtOnStatusChange,
  frHideNote,
  frHideWindowFrom,
  frIsHidden,
  frIsHideable,
  frNumber,
} from "./visibility";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

test("frNumber pads to the 7-digit ticket number", () => {
  assert.equal(frNumber(1), "#0000001");
  assert.equal(frNumber(2), "#0000002");
  assert.equal(frNumber(42), "#0000042");
  assert.equal(frNumber(1_234_567), "#1234567");
});

test("frNumber widens rather than truncating past 7 digits", () => {
  assert.equal(frNumber(12_345_678), "#12345678"); // a collision would be worse than a wide number
});

test("a request with no timer is never hidden", () => {
  assert.equal(frIsHidden(null, NOW), false);
  assert.equal(frHideNote(null, NOW), null);
});

test("a request hides only once its timer has run out", () => {
  assert.equal(frIsHidden(days(1), NOW), false); // still on the board
  assert.equal(frIsHidden(days(-1), NOW), true); // ran out yesterday
  assert.equal(frIsHidden(NOW, NOW), true); // exactly now — hideAt <= now
});

test("marking a request Implemented arms the 7-day timer", () => {
  const hideAt = frHideAtOnStatusChange("building", "done", NOW);
  assert.deepEqual(hideAt, days(FR_HIDE_WINDOW_DAYS));
  assert.equal(frIsHidden(hideAt as Date, NOW), false); // not hidden yet — that is the point
  assert.equal(frIsHidden(hideAt as Date, days(8)), true); // hidden a week later, with no sweep
});

test("reopening an implemented request puts it back on the board", () => {
  assert.equal(frHideAtOnStatusChange("done", "planned", NOW), null);
  assert.equal(frHideAtOnStatusChange("done", "building", NOW), null);
});

test("rejecting an open request does not auto-hide it — only Implemented arms the timer", () => {
  // undefined leaves hideAt as it was (null for an open request), so it stays on the board until an
  // admin hides it by hand.
  assert.equal(frHideAtOnStatusChange("new", "declined", NOW), undefined);
});

test("re-triaging Implemented -> Rejected does NOT drag a hidden request back onto the board", () => {
  // Both are terminal, so the running timer survives the re-triage. Returning null here would clear
  // the timer of a request that hid weeks ago and pop it back onto the board.
  assert.equal(frHideAtOnStatusChange("done", "declined", NOW), undefined);
});

test("a no-op status save leaves an admin's manual hide alone", () => {
  // undefined, not null: null would clobber a hide back onto the board.
  assert.equal(frHideAtOnStatusChange("done", "done", NOW), undefined);
});

test("only a resolved request may carry a hide timer", () => {
  // Guards BOTH hide and unhide. If unhide skipped this, it would arm a 7-day timer on an open
  // request, which would then silently retire itself into a table labelled "Completed".
  assert.equal(frIsHideable("done"), true);
  assert.equal(frIsHideable("declined"), true);
  for (const open of ["new", "planned", "building"]) assert.equal(frIsHideable(open), false, open);
});

test("re-marking Implemented after a reopen arms a fresh 7 days", () => {
  const first = frHideAtOnStatusChange("building", "done", NOW) as Date;
  const later = days(30);
  const second = frHideAtOnStatusChange("building", "done", later) as Date;
  assert.ok(second.getTime() > first.getTime());
  assert.deepEqual(second, new Date(later.getTime() + FR_HIDE_WINDOW_DAYS * 86_400_000));
});

test("unhiding grants another full window from now, not from the old deadline", () => {
  assert.deepEqual(frHideWindowFrom(NOW), days(FR_HIDE_WINDOW_DAYS));
  // A request that hid a month ago comes back for 7 days from today, not 7 days from when it hid.
  assert.deepEqual(frHideWindowFrom(days(30)), days(30 + FR_HIDE_WINDOW_DAYS));
});

test("the hide note counts down, then reads Hidden", () => {
  assert.equal(frHideNote(days(7), NOW), "Hides in 7 days");
  assert.equal(frHideNote(days(3), NOW), "Hides in 3 days");
  assert.equal(frHideNote(days(0.5), NOW), "Hides in under a day");
  assert.equal(frHideNote(days(-1), NOW), "Hidden");
});
