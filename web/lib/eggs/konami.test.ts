import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceKonami, KONAMI_LENGTH } from "./konami";

const SEQ = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

test("the full sequence completes", () => {
  let p = 0;
  for (const k of SEQ) p = advanceKonami(p, k);
  assert.equal(p, KONAMI_LENGTH);
});

test("keys are case-insensitive for B and A", () => {
  let p = 0;
  for (const k of ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "B", "A"]) {
    p = advanceKonami(p, k);
  }
  assert.equal(p, KONAMI_LENGTH);
});

test("a wrong key resets progress (but a fresh ArrowUp restarts the sequence)", () => {
  let p = 0;
  p = advanceKonami(p, "ArrowUp");
  p = advanceKonami(p, "ArrowUp");
  p = advanceKonami(p, "x");
  assert.equal(p, 0);
  // A wrong key that IS the first key restarts at 1, not 0.
  p = advanceKonami(2, "ArrowUp");
  assert.equal(p, 1);
});
