import { test } from "node:test";
import assert from "node:assert/strict";
import { advancePirate, PIRATE_LENGTH, piratify, pirateFlourish } from "./pirate";

function type(word: string, start = 0): number {
  let p = start;
  for (const k of word.split("")) p = advancePirate(p, k);
  return p;
}

test("typing pirate completes", () => {
  assert.equal(type("pirate"), PIRATE_LENGTH);
});

test("case does not matter", () => {
  assert.equal(type("PIRATE"), PIRATE_LENGTH);
  assert.equal(type("PiRaTe"), PIRATE_LENGTH);
});

test("a wrong letter resets progress (but p restarts the word)", () => {
  let p = type("pira");
  p = advancePirate(p, "x");
  assert.equal(p, 0);
  p = advancePirate(type("pira"), "p");
  assert.equal(p, 1);
});

test("modifier and navigation keys are neutral, not a reset", () => {
  let p = type("pira");
  for (const k of ["Shift", "ArrowUp", "Control", "Alt", "Meta", "CapsLock"]) {
    p = advancePirate(p, k);
  }
  assert.equal(p, 4);
  assert.equal(type("te", p), PIRATE_LENGTH);
});

test("completes even after leading garbage", () => {
  assert.equal(type("xyzpirate"), PIRATE_LENGTH);
});

test("piratify swaps whole words and keeps capitalization", () => {
  assert.equal(piratify("The user is ready"), "Th' landlubber be ready");
  assert.equal(piratify("You are the admin"), "Ye be th' cap'n");
});

test("piratify leaves embedded words alone", () => {
  // "is" inside "this", "hi" inside "history" — word boundaries must hold.
  assert.equal(piratify("this history"), "this history");
});

test("piratify drops the g from long -ing words only", () => {
  assert.equal(piratify("onboarding is missing"), "onboardin' be missin'");
  assert.equal(piratify("the ring"), "th' ring");
});

test("piratify handles all-caps words", () => {
  assert.equal(piratify("THE SERVER"), "TH' GALLEON");
});

test("piratify leaves numbers and punctuation untouched", () => {
  assert.equal(piratify("v2 runner 1.99.1 (#18)"), "v2 runner 1.99.1 (#18)");
});

test("flourish is deterministic and cycles", () => {
  assert.equal(pirateFlourish(0), pirateFlourish(6));
  assert.notEqual(pirateFlourish(0), pirateFlourish(1));
});
