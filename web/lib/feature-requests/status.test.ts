import { test } from "node:test";
import assert from "node:assert/strict";
import { FR_STATUSES, frIsOpen, frIsResolved, frStatusMeta } from "./status";

test("resolved is exactly Implemented and Rejected", () => {
  assert.equal(frIsResolved("done"), true);
  assert.equal(frIsResolved("declined"), true);
  for (const open of ["new", "planned", "building"]) assert.equal(frIsResolved(open), false, open);
});

test("open is the complement — the board and the tables can never both claim a request", () => {
  for (const s of FR_STATUSES) assert.equal(frIsOpen(s), !frIsResolved(s), s);
});

test("an untriaged status counts as open — work nobody has classified is still work", () => {
  // The board is the queue; a status this code doesn't know must land there rather than vanish into
  // a table labelled "Implemented and closed".
  assert.equal(frIsOpen("triage"), true);
  assert.equal(frIsResolved(""), false);
});

test("every status has a label and a badge colour", () => {
  for (const s of FR_STATUSES) {
    const meta = frStatusMeta(s);
    assert.ok(meta.label.length > 0, s);
    assert.ok(meta.fg && meta.bg, s);
  }
  assert.equal(frStatusMeta("nonsense").label, frStatusMeta("new").label); // unknown falls back to New
});
