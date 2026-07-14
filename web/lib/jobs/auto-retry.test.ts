import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutoRetry, carriedRetryMarker, MAX_AUTO_RETRIES, type AutoRetryMarker } from "./auto-retry";

const NOW = 1_800_000_000_000;

test("first wait: schedules the retry and starts the attempt count at 1", () => {
  const d = decideAutoRetry(null, 15, NOW);
  assert.equal(d.kind, "scheduled");
  if (d.kind !== "scheduled") return;
  assert.equal(d.marker.count, 1);
  assert.equal(d.marker.at, NOW + 15 * 60_000);
  assert.equal(d.marker.firstAt, NOW);
});

test("a subsequent wait increments the count and KEEPS the original firstAt", () => {
  const prev: AutoRetryMarker = { count: 3, firstAt: NOW - 45 * 60_000 };
  const d = decideAutoRetry(prev, 15, NOW);
  assert.equal(d.kind, "scheduled");
  if (d.kind !== "scheduled") return;
  assert.equal(d.marker.count, 4);
  assert.equal(d.marker.firstAt, NOW - 45 * 60_000, "firstAt anchors how long we've been waiting");
});

test("the executor stops asking for time -> resolved, with the attempts it took", () => {
  const d = decideAutoRetry({ count: 5, firstAt: NOW - 75 * 60_000 }, 0, NOW);
  assert.equal(d.kind, "resolved");
  if (d.kind !== "resolved") return;
  assert.equal(d.attempts, 5);
  assert.equal(d.elapsedMinutes, 75);
});

test("budget spent -> exhausted, NOT scheduled again (a wait that can never resolve must end)", () => {
  const d = decideAutoRetry({ count: MAX_AUTO_RETRIES, firstAt: NOW - 240 * 60_000 }, 15, NOW);
  assert.equal(d.kind, "exhausted");
  if (d.kind !== "exhausted") return;
  assert.equal(d.attempts, MAX_AUTO_RETRIES);
  assert.equal(d.elapsedMinutes, 240);
});

test("a step that never waited and isn't waiting now decides nothing", () => {
  assert.equal(decideAutoRetry(null, 0, NOW).kind, "none");
});

// The regression that made the cap dead code: requeue dropped the whole marker, so every re-queue
// handed recordResult a null `prev`, count reset to 1, and `count < MAX` was true forever. A user
// the vendor would never discover retried every 15 minutes indefinitely.
test("the attempt count SURVIVES an automatic requeue, so the cap actually bites", () => {
  let marker: AutoRetryMarker | null = null;
  for (let i = 0; i < 40; i++) {
    const d = decideAutoRetry(marker, 15, NOW); // the vendor never catches up: always asks to wait
    if (d.kind === "exhausted") {
      assert.equal(d.attempts, MAX_AUTO_RETRIES);
      assert.ok(i <= MAX_AUTO_RETRIES, "must give up within the budget");
      return;
    }
    assert.equal(d.kind, "scheduled");
    if (d.kind !== "scheduled") return;
    marker = carriedRetryMarker(d.marker, NOW); // <- what an auto-retry requeue puts back
  }
  assert.fail("never gave up — the retry budget is not being enforced");
});

test("an automatic requeue carries the count but drops `at` (the job is running, not scheduled)", () => {
  const carried = carriedRetryMarker({ at: NOW + 900_000, count: 4, firstAt: NOW - 60_000 }, NOW);
  // `at` first: assert.deepEqual is a type assertion, so it narrows `carried` and hides the field.
  assert.equal(carried?.at, undefined, "a stale `at` would advertise a next-try time for a running step");
  assert.deepEqual(carried, { count: 4, firstAt: NOW - 60_000 });
});

test("an operator re-run starts the budget over (nothing to carry)", () => {
  assert.equal(carriedRetryMarker(null, NOW), null);
});
