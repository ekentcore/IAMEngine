import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceGodfather, GODFATHER_LENGTH } from "./godfather";

function type(word: string, start = 0): number {
  let p = start;
  for (const k of word.split("")) p = advanceGodfather(p, k);
  return p;
}

test("typing godfather completes", () => {
  assert.equal(type("godfather"), GODFATHER_LENGTH);
});

test("case does not matter", () => {
  assert.equal(type("GODFATHER"), GODFATHER_LENGTH);
  assert.equal(type("GodFaTheR"), GODFATHER_LENGTH);
});

test("a wrong letter resets progress (but g restarts the word)", () => {
  let p = type("godf");
  p = advanceGodfather(p, "x");
  assert.equal(p, 0);
  p = advanceGodfather(type("godf"), "g");
  assert.equal(p, 1);
});

test("modifier and navigation keys are neutral, not a reset", () => {
  let p = type("godfa");
  for (const k of ["Shift", "ArrowUp", "Control", "Alt", "Meta", "CapsLock"]) {
    p = advanceGodfather(p, k);
  }
  assert.equal(p, 5);
  assert.equal(type("ther", p), GODFATHER_LENGTH);
});

test("completes even after leading garbage", () => {
  assert.equal(type("xyzgodfather"), GODFATHER_LENGTH);
});

test("a false start mid-word recovers", () => {
  assert.equal(type("godgodfather"), GODFATHER_LENGTH);
});
