import { test } from "node:test";
import assert from "node:assert/strict";
import { trashDaysLeft, isTrashExpired, purgeCutoff } from "./agent-trash";

const DAY = 86_400_000;
const now = new Date("2026-06-05T12:00:00Z");

test("trashDaysLeft counts down from 30 and floors at 0", () => {
  assert.equal(trashDaysLeft(now, now), 30); // just trashed
  assert.equal(trashDaysLeft(new Date(now.getTime() - 10 * DAY), now), 20);
  assert.equal(trashDaysLeft(new Date(now.getTime() - 29.5 * DAY), now), 1); // ceil of half a day
  assert.equal(trashDaysLeft(new Date(now.getTime() - 30 * DAY), now), 0);
  assert.equal(trashDaysLeft(new Date(now.getTime() - 40 * DAY), now), 0);
});

test("isTrashExpired at/after the retention window", () => {
  assert.equal(isTrashExpired(new Date(now.getTime() - 29 * DAY), now), false);
  assert.equal(isTrashExpired(new Date(now.getTime() - 30 * DAY), now), true);
  assert.equal(isTrashExpired(new Date(now.getTime() - 31 * DAY), now), true);
});

test("purgeCutoff is now minus the retention window", () => {
  assert.equal(purgeCutoff(now).toISOString(), new Date(now.getTime() - 30 * DAY).toISOString());
});
