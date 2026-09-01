import { test } from "node:test";
import assert from "node:assert/strict";
import { unmodeledManualJobs, unmodeledStepKey, unmodeledStepTitle, UNMODELED_PREFIX } from "./unmodeled-steps";

test("a section becomes one manual job carrying its steps as the note", () => {
  const jobs = unmodeledManualJobs([{ title: "Dropsuite", steps: ["Add the mailbox", "Confirm the backup"], guess: null }], 5);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "manual");
  assert.equal(jobs[0].systemKey, "unmodeled:dropsuite");
  assert.equal(jobs[0].sequence, 5);
  assert.deepEqual(jobs[0].dependsOn, []);          // depends on nothing
  assert.equal(jobs[0].requiresApproval, false);    // a checklist item, not destructive automation
  const cfg = jobs[0].config as { title: string; notes: string[] };
  assert.equal(cfg.title, "Dropsuite");
  assert.deepEqual(cfg.notes, ["Add the mailbox", "Confirm the backup"]);
});

test("the key is stable across runs — a re-plan must keep a ticked step ticked", () => {
  // replanCaseJobs keys kept jobs by systemKey. A key that drifted would recreate a completed
  // checklist item as untouched work on the next re-plan.
  const a = unmodeledManualJobs([{ title: "SalesForce (If requested)", steps: [], guess: null }], 0);
  const b = unmodeledManualJobs([{ title: "SalesForce (If requested)", steps: [], guess: null }], 0);
  assert.equal(a[0].systemKey, b[0].systemKey);
  assert.equal(a[0].systemKey, "unmodeled:salesforce-if-requested");
});

test("two sections that slug the same stay distinct", () => {
  const jobs = unmodeledManualJobs([
    { title: "Box", steps: ["a"], guess: null },
    { title: "Box!", steps: ["b"], guess: null },
  ], 0);
  assert.equal(jobs[0].systemKey, "unmodeled:box");
  assert.equal(jobs[1].systemKey, "unmodeled:box-2");
});

test("a section with no usable title is dropped rather than keyed to the bare prefix", () => {
  assert.deepEqual(unmodeledManualJobs([{ title: "   ", steps: ["x"], guess: null }], 0), []);
  assert.deepEqual(unmodeledManualJobs([{ title: "!!!", steps: ["x"], guess: null }], 0), []);
});

test("a section with no steps still becomes a job — the title IS the instruction", () => {
  const jobs = unmodeledManualJobs([{ title: "Greenstreet", steps: [], guess: null }], 0);
  assert.equal(jobs.length, 1);
  assert.deepEqual((jobs[0].config as { notes: string[] }).notes, ["Greenstreet"]);
});

test("a vendor guess is recorded so the step says what it probably is", () => {
  const jobs = unmodeledManualJobs([{ title: "Box", steps: ["Add the user"], guess: "Box (storage)" }], 0);
  const cfg = jobs[0].config as { guess: string | null };
  assert.equal(cfg.guess, "Box (storage)");
});

test("sequences increment from the start point so they land after the real plan", () => {
  const jobs = unmodeledManualJobs([
    { title: "Box", steps: [], guess: null },
    { title: "Verizon", steps: [], guess: null },
  ], 7);
  assert.deepEqual(jobs.map((j) => j.sequence), [7, 8]);
});

test("unmodeledStepTitle reads the label back off a planned job's request", () => {
  assert.equal(unmodeledStepTitle({ config: { title: "Visual Studio Subscriptions" } }), "Visual Studio Subscriptions");
  assert.equal(unmodeledStepTitle({ config: {} }), null);
  assert.equal(unmodeledStepTitle(null), null);
});

test("the prefix is what marks the class", () => {
  assert.ok(unmodeledStepKey("Box", new Set()).startsWith(UNMODELED_PREFIX));
});
