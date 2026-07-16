import { test } from "node:test";
import assert from "node:assert/strict";
import { isConvertConfirmed, isConvertStillComing } from "./mailbox-convert";

// The exact strings the Exchange executor emits. If these drift, the licence gate silently changes
// behaviour — in one direction it purges mail, in the other it bills a seat forever.
const CLOUD = "converted mailbox to shared";
const HYBRID_VERIFIED = "converted mailbox to shared on-prem (Set-RemoteMailbox -Type Shared) — verified shared in the cloud";
const HYBRID_PENDING =
  "WARN convert submitted on-prem (Set-RemoteMailbox -Type Shared) but the cloud still reads UserMailbox — awaiting an Entra Connect sync. The licence stays until it lands.";
const MAILUSER =
  "converted mailbox to shared on-prem (Set-RemoteMailbox -Type Shared) — mailbox is on-prem (a MailUser in EXO), so there is no cloud mailbox to purge";
const OVER_THRESHOLD = "mailbox 120 GB over threshold (50 GB) — kept as a user mailbox; license stays";
const SIZE_UNKNOWN = "WARN mailbox NOT converted — its size could not be read, so we cannot prove it is under the 50 GB shared-mailbox cap.";

test("a cloud-mastered convert is confirmed (Set-Mailbox takes effect immediately)", () => {
  assert.equal(isConvertConfirmed(["mailbox size: 0.05 GB", CLOUD]), true);
  assert.equal(isConvertConfirmed(["already a shared mailbox"]), true);
});

test("a hybrid convert counts ONLY once the cloud read-back confirms it", () => {
  assert.equal(isConvertConfirmed([HYBRID_VERIFIED]), true);
  // The dangerous one: the on-prem line CONTAINS the cloud phrase as a substring. Matching it here
  // would strip the licence off a mailbox the cloud still types UserMailbox -> Exchange purges it.
  assert.equal(isConvertConfirmed([HYBRID_PENDING]), false);
});

test("a legacy on-prem line from an older runner (no read-back) is NOT treated as converted", () => {
  // Safe by default: an unverified convert keeps the licence rather than risking the mailbox.
  assert.equal(isConvertConfirmed(["converted mailbox to shared on-prem (Set-RemoteMailbox -Type Shared)"]), false);
});

test("a MailUser is converted: the mail lives on-prem, so there is no cloud mailbox to purge", () => {
  assert.equal(isConvertConfirmed([MAILUSER]), true);
});

test("a declined convert is never confirmed", () => {
  assert.equal(isConvertConfirmed([OVER_THRESHOLD]), false);
  assert.equal(isConvertConfirmed([SIZE_UNKNOWN]), false);
  assert.equal(isConvertConfirmed([]), false);
});

test("a convert is still coming only while the exchange step can still run it", () => {
  for (const s of ["pending", "dispatched", "running", "manual"] as const) {
    assert.equal(isConvertStillComing(s, true), true, `${s} should be pending`);
  }
  // succeeded = it already decided; isConvertConfirmed says what it decided.
  assert.equal(isConvertStillComing("succeeded", true), false);
  // The trap this closes: a failed case marks every remaining job "skipped". Calling that "pending"
  // told the operator to re-run "once the mailbox step is done" — a state that can never arrive.
  assert.equal(isConvertStillComing("skipped", true), false);
  assert.equal(isConvertStillComing("failed", true), false);
});

test("no convert configured means nothing is ever pending", () => {
  assert.equal(isConvertStillComing("pending", false), false);
  assert.equal(isConvertStillComing("skipped", false), false);
});
