import test from "node:test";
import assert from "node:assert/strict";
import { parseMailboxOversize, isDecisionMarker } from "./decision-markers";

// The string the RUNNER actually emits, copied verbatim from
// runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 (the mailbox_oversize branch), with the
// PowerShell interpolation resolved. This is the whole point of the file: the two sides are bound by
// nothing but this string, so if the runner's wording drifts, THIS fails — instead of the button
// quietly never appearing on a case nobody is watching.
const RUNNER_LINE =
  "DECISION_NEEDED:mailbox_oversize | The mailbox is 75 GB, over the 50 GB cap, so it CANNOT be converted to a shared mailbox — a mailbox that big needs a licence either way. Removing the licence frees the seat, but Exchange purges the mailbox once its 30-day grace expires and the mail is GONE. Keeping it retains the mail and keeps paying for the seat. | sizeGB=75 | thresholdGB=50";

test("parses the marker the runner actually emits", () => {
  const d = parseMailboxOversize(["blocked sign-in", RUNNER_LINE, "WARN license KEPT for now — …"]);
  assert.ok(d, "the runner's own line must parse — if this fails the picker never renders");
  assert.equal(d.sizeGB, "75");
  assert.equal(d.thresholdGB, "50");
  assert.match(d.message, /CANNOT be converted to a shared mailbox/);
  assert.doesNotMatch(d.message, /sizeGB=/, "the message must stop at the first field delimiter");
});

test("returns null when no decision is pending", () => {
  assert.equal(parseMailboxOversize(["blocked sign-in", "removed from group: Sales"]), null);
});

test("an em dash inside the message does not break the field split", () => {
  // The message is full of prose punctuation; only `|` delimits. A greedy match would swallow the
  // fields into the message and lose the size.
  const d = parseMailboxOversize([RUNNER_LINE]);
  assert.equal(d?.sizeGB, "75");
});

test("a decimal size survives", () => {
  const d = parseMailboxOversize(["DECISION_NEEDED:mailbox_oversize | too big | sizeGB=51.5 | thresholdGB=50"]);
  assert.equal(d?.sizeGB, "51.5");
});

test("a different decision type is not mistaken for this one", () => {
  assert.equal(parseMailboxOversize(["DECISION_NEEDED:username_collision | x | upn=a@b.com | name=A B"]), null);
});

test("markers are recognised so the log can hide them", () => {
  assert.equal(isDecisionMarker(RUNNER_LINE), true);
  assert.equal(isDecisionMarker("WARN license KEPT for now — mailbox 75 GB is over the 50 GB cap"), false);
});
