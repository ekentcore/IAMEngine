import test from "node:test";
import assert from "node:assert/strict";
import { parseMailboxOversize, parseMailboxNotConverted, canConvert, isDecisionMarker, mailboxPurgeLines } from "./decision-markers";

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
  // Runner >= 1.69.0 sends $null-not-injected as "unknown" and a real empty mailbox as 0 — so 0 is a
  // KNOWN, convertible size now. (The old 0-sentinel hid Convert for exactly the cheapest mailboxes.)
  assert.equal(at("0"), true, "a real empty mailbox is known and convertible");
  assert.equal(at("-1"), false, "negative is garbage, never offer");
});

test("not-converted markers are recognised so the log can hide them", () => {
  assert.equal(isDecisionMarker(NOT_CONVERTED_LINE), true);
});

// Mail-destroying "license removed" lines fire the mailboxPurge chat event (runner-service). All
// three runner variants must match; ordinary removal/warn lines must not.
test("mailboxPurgeLines finds the mail-destroying removal lines — but only when a licence actually came off", () => {
  const FREED = "freed 2 directly-assigned license(s): SPE_E5, ENTERPRISEPACK";
  const destroys = [
    "license removed by operator decision — the mailbox is 61.2 GB, over the 50 GB cap, so it could never become shared. Exchange will DELETE it once its 30-day grace expires and the mail is not recoverable after that. Archive it now if it is needed.",
    // The $null-size re-run variant (the size wasn't re-injected on the removal re-run) — reworded in
    // the same batch; pin it so a regex tightening can't silently drop the alert for the common path.
    "license removed by operator decision — the mailbox is over the 50 GB cap (size not re-read on this run), so it could never become shared. Exchange will DELETE it once its 30-day grace expires and the mail is not recoverable after that. Archive it now if it is needed.",
    "license removed by operator decision — the mailbox was NOT converted to shared, so Exchange will DELETE it once its 30-day grace expires and the mail is not recoverable after that. Chosen on the case in preference to converting the mailbox or keeping the seat.",
    "license removed on a mailbox that was NOT converted to shared — this client is configured to allow it (removeLicense.allowWithoutConvert). Exchange will DELETE this mailbox once its 30-day grace expires: the mail is not recoverable after that. Archive it now if it is needed.",
  ];
  const benign = [
    "license kept here by design — it is removed in the entra step, after the mailbox is converted to shared",
    "WARN license KEPT — the mailbox was NOT converted to shared. Removing the license would let Exchange purge the mailbox after its 30-day grace, so the license stays until a human decides.",
    "license KEPT by operator decision — the mailbox was not converted to shared, and both the licence and the mailbox are being left as they are. The seat stays assigned.",
  ];
  const hits = mailboxPurgeLines({ Actions: [...destroys, ...benign, FREED] });
  assert.deepEqual(hits, destroys);
  assert.deepEqual(mailboxPurgeLines(null), []);
  assert.deepEqual(mailboxPurgeLines({ actions: [destroys[0], FREED] }), [destroys[0]]); // lower-case key too
});

// The announcement line is emitted on ENTERING the decided branch, before Set-MgUserLicense — a
// group-inherited rejection or an idempotent re-run re-emits it with nothing removed. No freed
// line = no alert, or chat gets a fresh (wrong) 30-day clock on every re-run.
test("no 'freed N' line — announcement alone must NOT fire the purge alert", () => {
  const announce = "license removed on a mailbox that was NOT converted to shared — this client is configured to allow it (removeLicense.allowWithoutConvert). Exchange will DELETE this mailbox once its 30-day grace expires: the mail is not recoverable after that. Archive it now if it is needed.";
  assert.deepEqual(mailboxPurgeLines({ Actions: [announce, "no licenses to remove"] }), []);
  assert.deepEqual(mailboxPurgeLines({ Actions: [announce, "WARN license NOT removed — Microsoft rejected the removal because the license is inherited from a GROUP membership"] }), []);
});
