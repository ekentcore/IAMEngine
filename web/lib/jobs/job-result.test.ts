import { test } from "node:test";
import assert from "node:assert/strict";
import { jobResultEnvelope } from "./job-result";

// The real shape from UM0029906: an exchange offboard whose result posted as a leaked pipeline array
// ([null, {…envelope…}]). Every reader doing result.MailboxSizeGB / result.Actions saw nothing, so
// the licence gate treated a converted 33 MB mailbox as size-unknown and asked a settled question.
const ENVELOPE = { System: "exchange", Status: "ok", MailboxSizeGB: 0.03, Actions: ["converted mailbox to shared"] };

test("a plain object result passes through untouched", () => {
  assert.equal(jobResultEnvelope(ENVELOPE), ENVELOPE);
});

test("a leaked [null, envelope] array is unwrapped to the envelope", () => {
  assert.deepEqual(jobResultEnvelope([null, ENVELOPE]), ENVELOPE);
});

test("the LAST object element wins — the envelope is the function's final output", () => {
  const leak = { Write: "host noise" };
  assert.deepEqual(jobResultEnvelope([leak, ENVELOPE]), ENVELOPE);
});

test("null / undefined / primitive results are returned as-is", () => {
  assert.equal(jobResultEnvelope(null), null);
  assert.equal(jobResultEnvelope(undefined), undefined);
  assert.equal(jobResultEnvelope("done"), "done");
});

test("an array with no object element collapses to null (nothing to read)", () => {
  assert.equal(jobResultEnvelope([null, null]), null);
  assert.equal(jobResultEnvelope([]), null);
  // A nested array is not an envelope — skip it, don't return it.
  assert.equal(jobResultEnvelope([["x"]]), null);
});
