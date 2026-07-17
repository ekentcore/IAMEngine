import { test } from "node:test";
import assert from "node:assert/strict";
import { frCounts } from "./counts";
import type { FeatureRequestRow } from "./serialize";

// Minimal row factory — frCounts only reads status + hidden.
function row(status: string, hidden = false): FeatureRequestRow {
  return {
    id: status + (hidden ? "-h" : ""),
    number: 1,
    title: "t",
    body: "",
    page: "/",
    status,
    resolutionNote: null,
    authorEmail: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    hideAt: hidden ? "2026-07-10T00:00:00.000Z" : null,
    hidden,
    hideNote: null,
  };
}

test("frCounts: total is every row; open excludes terminal statuses; implemented is done", () => {
  const rows = [row("new"), row("planned"), row("building"), row("done"), row("declined")];
  assert.deepEqual(frCounts(rows), { total: 5, open: 3, implemented: 1 });
});

test("frCounts: a hidden request is never open, but a hidden done still counts as implemented", () => {
  const rows = [row("done", true), row("declined", true), row("new")];
  // done(hidden) + declined(hidden) are off the board; only the open 'new' counts as open.
  assert.deepEqual(frCounts(rows), { total: 3, open: 1, implemented: 1 });
});

test("frCounts: no rows is all zeros", () => {
  assert.deepEqual(frCounts([]), { total: 0, open: 0, implemented: 0 });
});

test("frCounts: an unknown status is open (not terminal), matching the board's rule", () => {
  assert.deepEqual(frCounts([row("triage")]), { total: 1, open: 1, implemented: 0 });
});
