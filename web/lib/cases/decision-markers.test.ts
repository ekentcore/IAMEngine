import test from "node:test";
import assert from "node:assert/strict";
import { parseMailboxOversize, parseMailboxNotConverted, canConvert, isDecisionMarker } from "./decision-markers";

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

// --- mailbox_not_converted -----------------------------------------------------------------------
// Same contract, same stakes: copied verbatim from the mailbox_not_converted branch of the same psm1,
// PowerShell interpolation resolved (sizeGB=2.74 / thresholdGB=50 — the real UM0029840 numbers).
const NOT_CONVERTED_LINE =
  "DECISION_NEEDED:mailbox_not_converted | The mailbox was never converted to a shared mailbox, so the licence cannot be removed safely — Exchange deletes an unlicensed, unconverted mailbox once its 30-day grace expires. Converting it keeps the mail AND frees the seat. Removing the licence without converting frees the seat but the mail is GONE after the grace. Leaving both alone keeps the mail and keeps paying for the seat. | sizeGB=2.74 | thresholdGB=50";

test("parses the not-converted marker the runner actually emits", () => {
  const d = parseMailboxNotConverted(["blocked sign-in", NOT_CONVERTED_LINE, "WARN license KEPT — …"]);
  assert.ok(d, "the runner's own line must parse — if this fails the picker never renders");
  assert.equal(d.sizeGB, "2.74");
  assert.equal(d.thresholdGB, "50");
  assert.match(d.message, /never converted to a shared mailbox/);
  assert.doesNotMatch(d.message, /sizeGB=/, "the message must stop at the first field delimiter");
});

test("the two mailbox decisions are never mistaken for each other", () => {
  // They ask different questions with different answers — oversize CANNOT offer convert. Crossing them
  // would show an operator a button that cannot work, or hide the one that can.
  assert.equal(parseMailboxNotConverted([RUNNER_LINE]), null);
  assert.equal(parseMailboxOversize([NOT_CONVERTED_LINE]), null);
});

test("an unreadable size parses, and refuses to offer Convert", () => {
  // Exchange won't convert a mailbox it can't prove is under the cap, so Convert would be a button
  // guaranteed to fail. "unknown" must not become NaN-compares-false-and-we-offer-it-anyway.
  const d = parseMailboxNotConverted(["DECISION_NEEDED:mailbox_not_converted | m | sizeGB=unknown | thresholdGB=50"]);
  assert.equal(d?.sizeGB, "unknown");
  assert.equal(canConvert(d!), false);
});

test("Convert is offered under the cap and withheld at or over it", () => {
  const at = (size: string) => canConvert({ message: "m", sizeGB: size, thresholdGB: "50" });
  assert.equal(at("2.74"), true, "the real UM0029840 mailbox — convertible");
  assert.equal(at("50"), true, "exactly at the cap is still convertible");
  assert.equal(at("50.1"), false, "over the cap it cannot become shared — that's the oversize question");
  assert.equal(at("0"), false, "0 means the size was never read, not an empty mailbox");
});

test("not-converted markers are recognised so the log can hide them", () => {
  assert.equal(isDecisionMarker(NOT_CONVERTED_LINE), true);
});
