import { test } from "node:test";
import assert from "node:assert/strict";
import { withOffboardActions, readOffboardActions, changedOffboardActions, describeSaveOutcome, currentOffboardChoice, mailboxDeleteBlocker } from "./offboard-actions";
import type { PlannedJob } from "../orchestrator";

const job = (systemKey: string, config: Record<string, unknown> | null = null, mode = "api") =>
  ({ systemKey, sequence: 0, mode, requiresApproval: false, captureEvidence: false, intent: "disable", secretNames: [], dependsOn: [], config }) as unknown as PlannedJob;
const by = (jobs: PlannedJob[], k: string) => jobs.find((j) => j.systemKey === k)!;

test("no choice leaves the plan exactly as the client configured it", () => {
  const jobs = [job("google-workspace"), job("exchange", { convertToShared: true })];
  assert.equal(withOffboardActions(jobs, {}), jobs);
});

test("Google delete: deleteUser, and the step becomes destructive (approval + evidence)", () => {
  const g = by(withOffboardActions([job("google-workspace", { inactiveOu: "/Former" })], { offboardActions: { "google-workspace": "delete" } }), "google-workspace");
  assert.deepEqual(g.config, { inactiveOu: "/Former", deleteUser: true });
  assert.equal(g.intent, "destructive");
  assert.equal(g.requiresApproval, true);
  assert.equal(g.captureEvidence, true);
});

test("Google suspend over a client that deletes: deleteUser false, no gate added", () => {
  const g = by(withOffboardActions([job("google-workspace", { deleteUser: true })], { offboardActions: { "google-workspace": "suspend" } }), "google-workspace");
  assert.deepEqual(g.config, { deleteUser: false });
  assert.equal(g.requiresApproval, false);
});

test("Exchange delete: no convert, and the licence step may strip an unconverted mailbox — both gated", () => {
  const jobs = withOffboardActions(
    [job("exchange", { convertToShared: { skipIfMailboxOverGB: 50 } }), job("m365", { removeLicense: { note: "x" }, blockSignIn: true })],
    { offboardActions: { exchange: "delete" } },
  );
  assert.deepEqual(by(jobs, "exchange").config, { convertToShared: false });
  assert.deepEqual(by(jobs, "m365").config, { removeLicense: { note: "x", allowWithoutConvert: true }, blockSignIn: true });
  assert.equal(by(jobs, "exchange").requiresApproval, true);
  assert.equal(by(jobs, "m365").requiresApproval, true);
});

test("Exchange convert over a client that doesn't: convertToShared true, the licence step untouched", () => {
  const jobs = withOffboardActions([job("exchange", { convertToShared: false }), job("m365", { removeLicense: true })], { offboardActions: { exchange: "convert" } });
  assert.deepEqual(by(jobs, "exchange").config, { convertToShared: true });
  assert.deepEqual(by(jobs, "m365").config, { removeLicense: true });
});

test("Spanning remove frees the seat (destructive); archive swaps to Archive and drops a removal", () => {
  const rm = by(withOffboardActions([job("spanning", { swapLicense: { to: "Archive" } })], { offboardActions: { spanning: "remove" } }), "spanning");
  assert.deepEqual(rm.config, { removeLicense: true });
  assert.equal(rm.intent, "destructive");
  const ar = by(withOffboardActions([job("spanning", { removeLicense: true, unassign: true })], { offboardActions: { spanning: "archive" } }), "spanning");
  assert.deepEqual(ar.config, { swapLicense: { to: "Archive" } });
});

test("unknown systems and values in the payload are ignored", () => {
  assert.deepEqual(readOffboardActions({ offboardActions: { "google-workspace": "nuke", exchange: "delete", zoom: "delete" } }), { exchange: "delete" });
  assert.deepEqual(readOffboardActions({ offboardActions: "delete" }), {});
});

test("a manual step never gets an approval gate (the human doing it is the approval)", () => {
  const g = by(withOffboardActions([job("google-workspace", null, "manual")], { offboardActions: { "google-workspace": "delete" } }), "google-workspace");
  assert.equal(g.requiresApproval, false);
  assert.equal(g.intent, "destructive");
});

// ---- Review fixes -------------------------------------------------------------------------------

// Finding 1 (server side): a choice equal to what the client already does changes nothing. An untouched
// "delete" mailbox row on a client that never converts must not start stripping licences.
test("a choice equal to the client default leaves the plan exactly as configured", () => {
  const jobs = [
    job("exchange", { convertToShared: false }),
    job("m365", { removeLicense: true }),
    job("google-workspace", { inactiveOu: "/Former" }),
    job("spanning", { swapLicense: { to: "Archive" } }),
    job("entra", { removeLicense: true }),
  ];
  const out = withOffboardActions(jobs, { offboardActions: { exchange: "delete", "google-workspace": "suspend", spanning: "archive" } });
  assert.deepEqual(out, jobs);
});

test("convert on a client that already converts keeps its own threshold (not flattened to true)", () => {
  const ex = job("exchange", { convertToShared: { skipIfMailboxOverGB: 30 } });
  assert.deepEqual(by(withOffboardActions([ex], { offboardActions: { exchange: "convert" } }), "exchange"), ex);
});

// Finding 1 (UI): only the rows the operator changed are saved; an earlier saved choice is kept.
test("only changed rows are saved, merged over the case's earlier choices", () => {
  const rows = [
    { systemKey: "google-workspace", current: "suspend", locked: false },
    { systemKey: "exchange", current: "delete", locked: false }, // client default: no convert
    { systemKey: "spanning", current: "remove", locked: false }, // saved earlier on this case
  ] as const;
  const choice = { "google-workspace": "delete", exchange: "delete", spanning: "remove" };
  assert.deepEqual(changedOffboardActions({ spanning: "remove" }, [...rows], choice), { spanning: "remove", "google-workspace": "delete" });
  assert.deepEqual(changedOffboardActions({}, [...rows], { "google-workspace": "suspend", exchange: "delete", spanning: "remove" }), {});
});

// Finding 2: the save message reports the real re-plan outcome.
test("a failed re-plan is reported as a failure, not 'Saved — re-planned'", () => {
  assert.equal(describeSaveOutcome("replanned").ok, true);
  const f = describeSaveOutcome("client has no systems");
  assert.equal(f.ok, false);
  assert.match(f.text, /client has no systems/);
  assert.equal(describeSaveOutcome(null, { ok: false, error: "409" }).ok, false);
  assert.equal(describeSaveOutcome(null, { ok: true }).ok, true);
});

// Finding 3: the mailbox's current choice is read the way the Exchange executor reads it
// (Test-CtgConvertToShared over convertToShared, else mailbox.convertToShared).
test("mailbox current choice follows the executor's convertToShared reading", () => {
  const c = (cfg: Record<string, unknown>) => currentOffboardChoice("exchange", cfg);
  assert.equal(c({ convertToShared: true }), "convert");
  assert.equal(c({ convertToShared: { skipIfMailboxOverGB: 50 } }), "convert");
  assert.equal(c({ convertToShared: { value: true, unless: "x" } }), "convert");
  assert.equal(c({ mailbox: { convertToShared: true } }), "convert");
  assert.equal(c({ convertToShared: "yes" }), "convert");
  assert.equal(c({}), "delete"); // nothing configured: the executor converts nothing
  assert.equal(c({ convertToShared: false }), "delete");
  assert.equal(c({ convertToShared: { value: false } }), "delete");
  assert.equal(c({ convertToShared: { value: "no" } }), "delete");
  assert.equal(c({ convertToShared: "off" }), "delete");
  assert.equal(c({ convertToShared: "" }), "delete");
  assert.equal(c({ mailbox: { convertToShared: { value: false } } }), "delete");
  assert.equal(c({ convertToShared: null, mailbox: { convertToShared: false } }), "delete");
  assert.equal(currentOffboardChoice("google-workspace", { deleteUser: true }), "delete");
  assert.equal(currentOffboardChoice("spanning", { unassign: true }), "remove");
  assert.equal(currentOffboardChoice("spanning", {}), "archive");
});

// Finding 4: deleting the mailbox only lets a step that ALREADY removes the licence do so without a
// convert. It never turns licence removal on, and never overrides an explicit removeLicense:false.
test("mailbox delete respects removeLicense:false and never adds a licence removal", () => {
  const jobs = withOffboardActions(
    [job("exchange", { convertToShared: true }), job("m365", { removeLicense: false, blockSignIn: true }), job("entra", { blockSignIn: true })],
    { offboardActions: { exchange: "delete" } },
  );
  assert.deepEqual(by(jobs, "m365").config, { removeLicense: false, blockSignIn: true });
  assert.equal(by(jobs, "m365").requiresApproval, false);
  assert.deepEqual(by(jobs, "entra").config, { blockSignIn: true });
  assert.equal(by(jobs, "entra").intent, "disable");
});

test("mailbox delete leaves a deferred licence step alone and opens the step that removes it", () => {
  const jobs = withOffboardActions(
    [job("exchange", { convertToShared: true }), job("m365", { removeLicense: { defer: true, removedBy: "entra" } }), job("entra", { removeLicense: true })],
    { offboardActions: { exchange: "delete" } },
  );
  assert.deepEqual(by(jobs, "m365").config, { removeLicense: { defer: true, removedBy: "entra" } });
  assert.equal(by(jobs, "m365").requiresApproval, false);
  assert.deepEqual(by(jobs, "entra").config, { removeLicense: { allowWithoutConvert: true } });
  assert.equal(by(jobs, "entra").requiresApproval, true);
});

// Review N2: with no step in the plan that takes the licence off, "delete the mailbox" can't happen —
// not converting would just leave a licensed user mailbox. The option is unavailable, and a saved
// choice is ignored: the mailbox stays at the client default.
test("mailbox delete is ignored when no licence step in the plan removes the licence", () => {
  const cases: PlannedJob[][] = [
    [job("m365", { removeLicense: false })],
    [job("m365", { blockSignIn: true })],
    [job("m365", { removeLicense: { defer: true, removedBy: "entra" } })], // deferred to a step not in the plan
  ];
  for (const licence of cases) {
    const ex = job("exchange", { convertToShared: true });
    const out = withOffboardActions([ex, ...licence], { offboardActions: { exchange: "delete" } });
    assert.deepEqual(by(out, "exchange"), ex);
    assert.notEqual(mailboxDeleteBlocker([ex, ...licence]), null);
  }
  const ok = [job("exchange", { convertToShared: true }), job("m365", { removeLicense: { defer: true, removedBy: "entra" } }), job("entra", { removeLicense: true })];
  assert.equal(mailboxDeleteBlocker(ok), null);
  assert.equal(by(withOffboardActions(ok, { offboardActions: { exchange: "delete" } }), "exchange").requiresApproval, true);
});
