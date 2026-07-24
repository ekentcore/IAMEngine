import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceWord } from "./typed-word";

function type(word: string, keys: string[]): number {
  let p = 0;
  for (const k of keys) p = advanceWord(word, p, k);
  return p;
}

test("typing the word completes it, case-insensitively", () => {
  assert.equal(type("matrix", [..."matrix"]), 6);
  assert.equal(type("matrix", [..."MaTrIx"]), 6);
  assert.equal(type("missionimpossible", [..."missionimpossible"]), 17);
});

test("a wrong character resets progress (back to 1 if it was the first letter)", () => {
  assert.equal(type("matrix", [..."matz"]), 0);
  assert.equal(type("matrix", [..."matm"]), 1); // 'm' restarts the word
  assert.equal(type("matrix", [..."matmatrix"]), 6); // and it still completes after
});

test("non-character keys (Shift, Escape, arrows) are neutral", () => {
  assert.equal(type("hal", ["h", "Shift", "a", "ArrowDown", "Escape", "l"]), 3);
});

test("progress never exceeds a completed word without a caller reset", () => {
  // The caller resets on completion; advancing past the end restarts like any mismatch.
  const p = type("hal", [..."hal"]);
  assert.equal(p, 3);
  assert.equal(advanceWord("hal", 0, "h"), 1);
});
