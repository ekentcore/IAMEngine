import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionStorageKey,
  marksAfterDismiss,
  parseSeenMarks,
  shouldShowAttention,
  type AttentionData,
} from "./seen";

const NONE: AttentionData = { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 0, maxFrNumber: 0 };
const BOTH: AttentionData = { pendingRequests: 3, latestRequestAt: "2026-07-24T12:00:00.000Z", newFeatureRequests: 5, maxFrNumber: 41 };

test("never-seen viewer with pending items → show", () => {
  assert.equal(shouldShowAttention(BOTH, null), true);
});

test("nothing pending never shows, even never-seen", () => {
  assert.equal(shouldShowAttention(NONE, null), false);
});

test("dismiss then same data → hidden", () => {
  const marks = marksAfterDismiss(BOTH, null);
  assert.equal(shouldShowAttention(BOTH, marks), false);
});

test("approve-then-new-arrival pops even though the COUNT is back to what was seen", () => {
  // Seen 3 pending; one approved (3→2); a NEW one arrives (2→3, newer timestamp).
  const marks = marksAfterDismiss(BOTH, null);
  const after: AttentionData = { ...BOTH, pendingRequests: 3, latestRequestAt: "2026-07-24T13:30:00.000Z" };
  assert.equal(shouldShowAttention(after, marks), true);
});

test("categories trigger independently", () => {
  const marks = marksAfterDismiss(BOTH, null);
  const newFr: AttentionData = { ...BOTH, maxFrNumber: 42, newFeatureRequests: 6 };
  assert.equal(shouldShowAttention(newFr, marks), true);
  const newReq: AttentionData = { ...BOTH, latestRequestAt: "2026-07-25T00:00:00.000Z" };
  assert.equal(shouldShowAttention(newReq, marks), true);
});

test("a category emptying out does not lose its mark", () => {
  // Dismissed with 3 pending; all get approved (0 pending, null timestamp); dismiss again on an
  // FR-only popup must NOT reset requestsAt — the old requests were seen, only NEWER ones may pop.
  const first = marksAfterDismiss(BOTH, null);
  const emptied: AttentionData = { ...BOTH, pendingRequests: 0, latestRequestAt: null };
  const second = marksAfterDismiss(emptied, first);
  assert.equal(second.requestsAt, BOTH.latestRequestAt);
  assert.equal(second.frMax, 41);
});

test("corrupt or missing stored JSON counts as never-seen", () => {
  assert.equal(parseSeenMarks(null), null);
  assert.equal(parseSeenMarks("not json {"), null);
  assert.equal(parseSeenMarks('"just a string"'), null);
  const partial = parseSeenMarks('{"frMax":"nope"}');
  assert.deepEqual(partial, { requestsAt: null, frMax: 0 });
});

test("storage key is per user, with a dev fallback", () => {
  assert.equal(attentionStorageKey("u123"), "admin_attention_seen:u123");
  assert.equal(attentionStorageKey(null), "admin_attention_seen:local");
});
