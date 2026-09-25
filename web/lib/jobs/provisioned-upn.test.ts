import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionedUpnFrom, sharepointAccountDecision, type SiblingResult } from "./provisioned-upn";

// PR #111 review: the hire created at a FALLBACK username must be the one downstream steps act on.
test("the created account comes from the m365 result, not the payload's primary candidate", () => {
  const upn = provisionedUpnFrom([{ systemKey: "m365", status: "succeeded", result: { System: "m365", Status: "ok", Upn: "john.smith2@contoso.com" } }]);
  assert.equal(upn, "john.smith2@contoso.com");
});

test("an array-shaped result is unwrapped, and entra is used when there is no m365 step", () => {
  assert.equal(provisionedUpnFrom([{ systemKey: "entra", status: "succeeded", result: [null, { Upn: "a@x.com" }] }]), "a@x.com");
});

test("m365 wins over entra; a failed or result-less step gives nothing", () => {
  assert.equal(
    provisionedUpnFrom([
      { systemKey: "entra", status: "succeeded", result: { Upn: "e@x.com" } },
      { systemKey: "m365", status: "succeeded", result: { Upn: "m@x.com" } },
    ]),
    "m@x.com"
  );
  assert.equal(provisionedUpnFrom([{ systemKey: "m365", status: "failed", result: { Upn: "m@x.com" } }]), null);
  assert.equal(provisionedUpnFrom([{ systemKey: "m365", status: "succeeded", result: { priorStatus: "failed", manualCompletion: true } }]), null);
  assert.equal(provisionedUpnFrom([]), null);
});

// ── sharepointAccountDecision (PR #111 reviews 2-4) ──────────────────────────────────────────────
const RAN = "2026-09-23T10:00:00.000Z";          // the m365 run started
const FAILED_AT = "2026-09-23T10:01:00.000Z";    // ...and failed (username taken)
const ACCEPTED_AT = "2026-09-23T10:30:00.000Z";
const m365 = (over: Partial<SiblingResult>): SiblingResult => ({ systemKey: "m365", mode: "api", status: "succeeded", result: null, startedAt: RAN, ...over });
const acceptedFailure = m365({ status: "failed", latestFailure: { at: FAILED_AT, resolvedAt: ACCEPTED_AT } });
const opSet = (at: string) => ({ userPrincipalName: "jsmith2@contoso.com", fieldSource: { userPrincipalName: "operator" }, fieldEditedAt: { userPrincipalName: at } });
const intake = { userPrincipalName: "jsmith@contoso.com" };

test("reported: a succeeded api step's Upn is handed on", () => {
  const d = sharepointAccountDecision([m365({ result: { Upn: "jsmith2@contoso.com" } })], intake);
  assert.equal(d.accountRule, "reported");
  assert.equal(d.provisionedUpn, "jsmith2@contoso.com");
});

test("wait: an api step that can still report the account (incl. an unaccepted failure)", () => {
  for (const status of ["pending", "dispatched", "running", "failed"]) {
    assert.equal(sharepointAccountDecision([m365({ status })], intake).accountRule, "wait", status);
  }
});

// Round 4: an acceptance carried over from an EARLIER run doesn't cover a re-run now waiting on a decision.
test("wait: an acceptance from an earlier run does not count for the latest run", () => {
  const rerun = m365({ status: "failed", startedAt: "2026-09-23T11:00:00.000Z", latestFailure: { at: FAILED_AT, resolvedAt: ACCEPTED_AT } });
  assert.equal(sharepointAccountDecision([rerun], opSet("2026-09-23T12:00:00.000Z")).accountRule, "wait");
});

// Round 4: jsmith@ is John Smith's, m365 failed, the operator accepted it and created jsmith2@ by hand
// without editing Username. The sole-candidate primary must NOT be used.
test("operator-required: accepted failure / done by hand / no Upn never falls back to the primary", () => {
  const notReported = [
    acceptedFailure,
    m365({ result: { priorStatus: "failed", manualCompletion: true } }),
    m365({ result: { Status: "ok" } }),
    m365({ status: "skipped" }),
  ];
  for (const s of notReported) {
    const d = sharepointAccountDecision([s], intake);
    assert.equal(d.accountRule, "operator-required", JSON.stringify(s));
    assert.equal(d.confirmedUpn, null);
    assert.match(d.accountReason ?? "", /m365 step didn't report the account/);
  }
  assert.match(sharepointAccountDecision([acceptedFailure], intake).accountReason!, /failure was accepted/);
  assert.match(sharepointAccountDecision([m365({ result: { manualCompletion: true } })], intake).accountReason!, /marked complete by hand/);
});

test("operator-required: a Username set AFTER the step last ran is confirmed; one set before is stale", () => {
  assert.equal(sharepointAccountDecision([acceptedFailure], opSet("2026-09-23T10:40:00.000Z")).confirmedUpn, "jsmith2@contoso.com");
  assert.equal(sharepointAccountDecision([acceptedFailure], opSet("2026-09-23T09:00:00.000Z")).confirmedUpn, null);
  // Operator-set but never stamped (edited before stamping existed): not provably fresh.
  const unstamped = { userPrincipalName: "jsmith2@contoso.com", fieldSource: { userPrincipalName: "operator" } };
  assert.equal(sharepointAccountDecision([acceptedFailure], unstamped).confirmedUpn, null);
  // "Last ran" is the run, not the manual flip: an edit made before "mark complete" but after the run counts.
  const doneByHand = m365({ progressAt: "2026-09-23T10:05:00.000Z", result: { manualCompletion: true } });
  assert.equal(sharepointAccountDecision([doneByHand], opSet("2026-09-23T10:20:00.000Z")).confirmedUpn, "jsmith2@contoso.com");
  assert.equal(sharepointAccountDecision([doneByHand], opSet("2026-09-23T10:03:00.000Z")).confirmedUpn, null);
});

test("planned-manual: a manual/scim step BY PLAN prefers an operator-set Username, else leaves the sole candidate to the runner", () => {
  for (const s of [m365({ mode: "manual", status: "manual", startedAt: null }), m365({ mode: "scim", startedAt: null })]) {
    assert.deepEqual(sharepointAccountDecision([s], intake), { provisionedUpn: null, accountRule: "planned-manual", confirmedUpn: null, accountReason: null });
    assert.equal(sharepointAccountDecision([s], opSet("2020-01-01T00:00:00.000Z")).confirmedUpn, "jsmith2@contoso.com");
  }
});

test("no-cloud-step: nothing to wait for or distrust", () => {
  assert.equal(sharepointAccountDecision([], intake).accountRule, "no-cloud-step");
});
