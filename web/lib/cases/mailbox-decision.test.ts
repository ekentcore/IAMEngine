import test from "node:test";
import assert from "node:assert/strict";
import { planMailboxDecision, isMailboxPolicy } from "./mailbox-decision";

// The real UM0029840 shape: exchange runs first, the licence lives on the entra lane.
const CASE_JOBS = [
  { id: "j-sn", systemKey: "servicenow" },
  { id: "j-ex", systemKey: "exchange" },
  { id: "j-m365", systemKey: "m365" },
  { id: "j-entra", systemKey: "entra" },
];

test("convert re-queues exchange BEFORE the licence steps", () => {
  // THE invariant. With exchange still `succeeded`, a re-queued entra is immediately claimable and a
  // runner polling in that window re-runs it against the stale exchange result — mailboxConverted is
  // still false, so it just asks again and the operator's answer evaporates. Exchange must go back to
  // pending first so the DAG holds entra behind it.
  const p = planMailboxDecision("convert", CASE_JOBS);
  assert.ok(p.ok);
  assert.deepEqual(p.requeue, ["j-ex", "j-m365", "j-entra"]);
  assert.equal(p.requeue[0], "j-ex", "exchange must be first — see the header comment");
});

test("convert writes convertToShared to the EXCHANGE step, not the licence step", () => {
  // The licence step cannot convert anything: it talks Graph, and Set-Mailbox -Type Shared is Exchange
  // Online. Writing the flag to the wrong step is a no-op that still reports success.
  const p = planMailboxDecision("convert", CASE_JOBS);
  assert.ok(p.ok);
  assert.deepEqual(p.writes, [{ jobIds: ["j-ex"], key: "convertToShared", value: true }]);
});

test("convert carries no policy of its own", () => {
  // The licence step needs none: it observes mailboxConverted=true on its re-run. A second source of
  // truth for one fact is how the two drift apart.
  const p = planMailboxDecision("convert", CASE_JOBS);
  assert.ok(p.ok);
  assert.equal(p.writes.some((w) => w.key === "mailboxNotConvertedPolicy"), false);
});

test("remove and keep write the policy to BOTH licence lanes", () => {
  // m365 AND entra: the executor serves both and the licence is usually on entra. Writing to only one
  // is the bug the m365-override route already paid for — the answer is accepted, lands on zero jobs,
  // and the same decision comes back with nothing to show why.
  for (const policy of ["remove", "keep"] as const) {
    const p = planMailboxDecision(policy, CASE_JOBS);
    assert.ok(p.ok);
    assert.deepEqual(p.writes, [{ jobIds: ["j-m365", "j-entra"], key: "mailboxNotConvertedPolicy", value: policy }]);
  }
});

test("remove and keep never touch the exchange step", () => {
  // Neither answer converts anything, so re-running exchange would be pointless work on a live mailbox.
  for (const policy of ["remove", "keep"] as const) {
    const p = planMailboxDecision(policy, CASE_JOBS);
    assert.ok(p.ok);
    assert.equal(p.requeue.includes("j-ex"), false);
    assert.deepEqual(p.requeue, ["j-m365", "j-entra"]);
  }
});

test("a case with no licence step is refused, not silently accepted", () => {
  const p = planMailboxDecision("keep", [{ id: "j-ex", systemKey: "exchange" }]);
  assert.equal(p.ok, false);
  assert.equal(p.ok === false && p.status, 422);
});

test("convert is refused when there is no exchange step to convert with", () => {
  // A cloud-only client with no Exchange step has nothing that can run Set-Mailbox. Offering to convert
  // and then queueing nothing would leave the case exactly as it was, reported as done.
  const p = planMailboxDecision("convert", [{ id: "j-entra", systemKey: "entra" }]);
  assert.equal(p.ok, false);
  assert.equal(p.ok === false && p.status, 422);
  assert.match(p.ok === false ? p.error : "", /no Exchange step/);
});

test("only the three real answers are policies", () => {
  for (const v of ["convert", "remove", "keep"]) assert.equal(isMailboxPolicy(v), true);
  for (const v of ["", "delete", "purge", "REMOVE", null, undefined, 1, {}]) assert.equal(isMailboxPolicy(v), false);
});
