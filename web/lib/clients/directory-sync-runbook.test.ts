import { test } from "node:test";
import assert from "node:assert/strict";
import { planDirectorySyncSectionInsert, directorySyncSectionRow, DIRECTORY_SYNC_KEY } from "./directory-sync-runbook";

// Ordered (by seq) sections for one action, minimal shape the planner needs.
const s = (seq: number, systemKey: string | null) => ({ seq, systemKey });

test("inserts right after the active-directory section, bumping the following sections", () => {
  // onboard: servicenow(0), active-directory(1), m365(2), mimecast(3)
  const sections = [s(0, "servicenow"), s(1, "active-directory"), s(2, "m365"), s(3, "mimecast")];
  const plan = planDirectorySyncSectionInsert(sections);
  assert.equal(plan.alreadyPresent, false);
  assert.equal(plan.insertSeq, 2); // takes m365's seq
  assert.equal(plan.shiftFromSeq, 2); // m365 and everything after bump by 1
});

test("respects a seq gap between anchor and the next section", () => {
  // active-directory(8), m365(9) — offboard with a global seq offset
  const sections = [s(7, "servicenow"), s(8, "active-directory"), s(9, "m365"), s(10, "exchange")];
  const plan = planDirectorySyncSectionInsert(sections);
  assert.equal(plan.insertSeq, 9);
  assert.equal(plan.shiftFromSeq, 9);
});

test("appends after active-directory when it is the last section (no shift)", () => {
  const sections = [s(0, "servicenow"), s(1, "active-directory")];
  const plan = planDirectorySyncSectionInsert(sections);
  assert.equal(plan.insertSeq, 2);
  assert.equal(plan.shiftFromSeq, null);
});

test("falls back to after servicenow when there is no active-directory section", () => {
  const sections = [s(0, "servicenow"), s(1, "m365")];
  const plan = planDirectorySyncSectionInsert(sections);
  assert.equal(plan.insertSeq, 1); // m365's seq
  assert.equal(plan.shiftFromSeq, 1);
});

test("falls back to the front when neither active-directory nor servicenow is present", () => {
  const sections = [s(0, "m365"), s(1, "mimecast")];
  const plan = planDirectorySyncSectionInsert(sections);
  assert.equal(plan.insertSeq, 0);
  assert.equal(plan.shiftFromSeq, 0);
});

test("empty runbook action: insert at seq 0, no shift", () => {
  const plan = planDirectorySyncSectionInsert([]);
  assert.equal(plan.insertSeq, 0);
  assert.equal(plan.shiftFromSeq, null);
});

test("idempotent: reports alreadyPresent when a directory-sync section exists", () => {
  const sections = [s(0, "active-directory"), s(1, "directory-sync"), s(2, "m365")];
  const plan = planDirectorySyncSectionInsert(sections);
  assert.equal(plan.alreadyPresent, true);
});

test("anchors after the LAST dependency section when it also waits on exchange", () => {
  // A hybrid-Exchange client (coretelligent): directory-sync runs after exchange, so its section
  // belongs after exchange — not merely after active-directory.
  const sections = [s(0, "active-directory"), s(1, "entra"), s(2, "exchange"), s(3, "m365")];
  const plan = planDirectorySyncSectionInsert(sections, ["exchange", "active-directory"]);
  assert.equal(plan.insertSeq, 3); // takes m365's seq (right after exchange)
  assert.equal(plan.shiftFromSeq, 3);
});

test("with exchange anchor absent from this lane, falls back to active-directory", () => {
  // Same deps, but this action has no exchange section — anchor on active-directory instead.
  const sections = [s(0, "servicenow"), s(1, "active-directory"), s(2, "m365")];
  const plan = planDirectorySyncSectionInsert(sections, ["exchange", "active-directory"]);
  assert.equal(plan.insertSeq, 2); // after active-directory
  assert.equal(plan.shiftFromSeq, 2);
});

test("directorySyncSectionRow builds an automated AD Sync section with the lead line", () => {
  const row = directorySyncSectionRow("onboard", null, "KB0018049");
  assert.equal(row.systemKey, DIRECTORY_SYNC_KEY);
  assert.equal(row.title, "AD Sync");
  assert.equal(row.status, "automated");
  assert.equal(row.kbArticle, "KB0018049");
  assert.equal(row.steps[0], "AD Sync: automated — the runner performs the onboard steps.");
});

test("directorySyncSectionRow renders config lines as indented sub-steps (exchange waitForMailbox)", () => {
  const config = { onboard: { command: "Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox: true } };
  const row = directorySyncSectionRow("onboard", config, null);
  assert.ok(row.steps.length > 1, "expected config sub-steps beyond the lead line");
  assert.ok(row.steps.slice(1).every((l) => l.startsWith("  ")), "config lines should be indented");
  assert.equal(row.kbArticle, null);
});
