import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceStarwars, STARWARS_LENGTH } from "./starwars";

function type(word: string, start = 0): number {
  let p = start;
  for (const k of word.split("")) p = advanceStarwars(p, k);
  return p;
}

test("typing starwars completes", () => {
  assert.equal(type("starwars"), STARWARS_LENGTH);
});

test("case does not matter", () => {
  assert.equal(type("STARWARS"), STARWARS_LENGTH);
  assert.equal(type("StArWaRs"), STARWARS_LENGTH);
});

test("a wrong letter resets progress (but s restarts the word)", () => {
  let p = type("star");
  p = advanceStarwars(p, "x");
  assert.equal(p, 0);
  p = advanceStarwars(type("star"), "s");
  assert.equal(p, 1);
});

test("modifier and navigation keys are neutral, not a reset", () => {
  let p = type("star");
  for (const k of ["Shift", "ArrowUp", "Control", "Alt", "Meta", "CapsLock"]) {
    p = advanceStarwars(p, k);
  }
  assert.equal(p, 4);
  assert.equal(type("wars", p), STARWARS_LENGTH);
});

test("completes even after leading garbage", () => {
  assert.equal(type("xyzstarwars"), STARWARS_LENGTH);
});
