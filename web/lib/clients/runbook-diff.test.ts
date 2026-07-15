import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRunbookSections, summarizeRunbookDiff, type SectionRef } from "./runbook-diff";

const s = (over: Partial<SectionRef> & { title: string }): SectionRef => ({
  seq: 0,
  systemKey: null,
  status: "automated",
  steps: [],
  ...over,
});

test("identical runbooks are a no-op", () => {
  const before = [s({ seq: 0, title: "M365", systemKey: "m365", steps: ["Create the mailbox", "Assign E3"] })];
  const d = diffRunbookSections(before, [...before]);
  assert.equal(d.noop, true);
  assert.equal(d.unchanged, 1);
  assert.deepEqual(d.changed, []);
  assert.equal(summarizeRunbookDiff(d), "no changes");
});

test("an added section is reported with its step count", () => {
  const before = [s({ seq: 0, title: "M365", systemKey: "m365" })];
  const after = [...before, s({ seq: 1, title: "Mimecast", systemKey: "mimecast", steps: ["Add to the group"] })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].systemKey, "mimecast");
  assert.equal(d.added[0].steps, 1);
  assert.equal(d.removed.length, 0);
  assert.equal(d.noop, false);
});

test("a removed section is reported — the case that silently breaks a client", () => {
  const before = [
    s({ seq: 0, title: "M365", systemKey: "m365" }),
    s({ seq: 1, title: "Spanning", systemKey: "spanning", steps: ["Assign a Standard licence"] }),
  ];
  const after = [s({ seq: 0, title: "M365", systemKey: "m365" })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].systemKey, "spanning");
  assert.equal(d.added.length, 0);
});

test("step add/remove within a section is captured with the actual text", () => {
  const before = [s({ seq: 0, title: "AD", systemKey: "ad", steps: ["Create the user", "Add to Staff"] })];
  const after = [s({ seq: 0, title: "AD", systemKey: "ad", steps: ["Create the user", "Add to All Staff", "Set the manager"] })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.changed.length, 1);
  const steps = d.changed[0].steps!;
  assert.deepEqual(steps.added, ["Add to All Staff", "Set the manager"]);
  assert.deepEqual(steps.removed, ["Add to Staff"]);
  assert.equal(steps.countFrom, 2);
  assert.equal(steps.countTo, 3);
});

test("a section renamed but keeping its systemKey is an edit, not remove+add", () => {
  const before = [s({ seq: 0, title: "M365", systemKey: "m365" })];
  const after = [s({ seq: 0, title: "Microsoft 365", systemKey: "m365" })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].titleFrom, "M365");
  assert.equal(d.changed[0].titleTo, "Microsoft 365");
});

test("a pure reorder is reordered, not edited", () => {
  const before = [
    s({ seq: 0, title: "M365", systemKey: "m365" }),
    s({ seq: 1, title: "AD", systemKey: "ad" }),
  ];
  const after = [
    s({ seq: 0, title: "AD", systemKey: "ad" }),
    s({ seq: 1, title: "M365", systemKey: "m365" }),
  ];
  const d = diffRunbookSections(before, after);
  assert.equal(d.changed.length, 0);
  assert.equal(d.reordered.length, 2);
  assert.equal(d.noop, false);
  assert.equal(summarizeRunbookDiff(d), "2 reordered");
});

test("unmodeled sections match on normalized title, so whitespace/case churn is a no-op", () => {
  const before = [s({ seq: 0, title: "Notify the manager", steps: ["Email  them"] })];
  const after = [s({ seq: 0, title: "notify the   manager", steps: ["Email them"] })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.noop, true, "title + step whitespace/case normalization should not read as a change");
});

test("status flip (automated → unmodeled) is recorded", () => {
  const before = [s({ seq: 0, title: "Adobe", systemKey: "adobe", status: "automated" })];
  const after = [s({ seq: 0, title: "Adobe", systemKey: "adobe", status: "unmodeled" })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.changed[0].statusFrom, "automated");
  assert.equal(d.changed[0].statusTo, "unmodeled");
});

test("duplicate steps are diffed by count, not as a set", () => {
  const before = [s({ seq: 0, title: "X", steps: ["Reboot", "Reboot"] })];
  const after = [s({ seq: 0, title: "X", steps: ["Reboot"] })];
  const d = diffRunbookSections(before, after);
  assert.deepEqual(d.changed[0].steps!.removed, ["Reboot"], "one of the two duplicates was removed");
  assert.deepEqual(d.changed[0].steps!.added, []);
});

test("a first-ever save (empty before) reports every section as added", () => {
  const after = [s({ seq: 0, title: "M365", systemKey: "m365" }), s({ seq: 1, title: "AD", systemKey: "ad" })];
  const d = diffRunbookSections([], after);
  assert.equal(d.added.length, 2);
  assert.equal(d.removed.length, 0);
  assert.equal(summarizeRunbookDiff(d), "+2 sections");
});

test("wiping the runbook reports every section as removed", () => {
  const before = [s({ seq: 0, title: "M365", systemKey: "m365" })];
  const d = diffRunbookSections(before, []);
  assert.equal(d.removed.length, 1);
  assert.equal(summarizeRunbookDiff(d), "−1 section");
});

test("long step text is clipped so one paste can't bloat the audit detail", () => {
  const long = "x".repeat(500);
  const d = diffRunbookSections([s({ seq: 0, title: "X" })], [s({ seq: 0, title: "X", steps: [long] })]);
  const added = d.changed[0].steps!.added[0];
  assert.ok(added.length < 320, `expected clipped, got ${added.length}`);
  assert.ok(added.endsWith("…"));
});

test("huge section lists are capped", () => {
  const after = Array.from({ length: 60 }, (_, i) => s({ seq: i, title: `S${i}` }));
  const d = diffRunbookSections([], after);
  assert.equal(d.added.length, 25, "listed sections are capped at 25");
});

test("a runbook naming the same system twice is a no-op when unchanged", () => {
  // Real shape: "M365 mailbox" and "M365 licences" both map to systemKey m365. Keyed by systemKey
  // alone the second would shadow the first, and every save would report a phantom edit.
  const rows = [
    s({ seq: 0, systemKey: "m365", title: "M365 mailbox", steps: ["Create the mailbox"] }),
    s({ seq: 1, systemKey: "m365", title: "M365 licences", steps: ["Assign E3"] }),
  ];
  const d = diffRunbookSections(rows, rows.map((r) => ({ ...r })));
  assert.equal(d.noop, true);
  assert.equal(d.unchanged, 2);
  assert.equal(d.changed.length, 0);
});

test("a real edit to one of two same-system sections is attributed to that section only", () => {
  const before = [
    s({ seq: 0, systemKey: "m365", title: "M365 mailbox", steps: ["Create the mailbox"] }),
    s({ seq: 1, systemKey: "m365", title: "M365 licences", steps: ["Assign E3"] }),
  ];
  const after = [
    s({ seq: 0, systemKey: "m365", title: "M365 mailbox", steps: ["Create the mailbox"] }),
    s({ seq: 1, systemKey: "m365", title: "M365 licences", steps: ["Assign E5"] }),
  ];
  const d = diffRunbookSections(before, after);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].title, "M365 licences");
  assert.deepEqual(d.changed[0].steps!.added, ["Assign E5"]);
  assert.deepEqual(d.changed[0].steps!.removed, ["Assign E3"]);
  assert.equal(d.unchanged, 1);
});

test("dropping one of two same-system sections reads as a removal, not an edit", () => {
  const before = [
    s({ seq: 0, systemKey: "m365", title: "M365 mailbox", steps: ["Create the mailbox"] }),
    s({ seq: 1, systemKey: "m365", title: "M365 licences", steps: ["Assign E3"] }),
  ];
  const after = [s({ seq: 0, systemKey: "m365", title: "M365 mailbox", steps: ["Create the mailbox"] })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].title, "M365 licences");
  assert.equal(d.changed.length, 0);
});

test("two unmodeled sections sharing a title do not collapse", () => {
  const rows = [
    s({ seq: 0, title: "Notes", steps: ["First"] }),
    s({ seq: 1, title: "Notes", steps: ["Second"] }),
  ];
  const d = diffRunbookSections(rows, rows.map((r) => ({ ...r })));
  assert.equal(d.noop, true);
  assert.equal(d.unchanged, 2);
});

test("deleting a mid-list section does not report the sections below it as reordered", () => {
  // saveRunbook re-indexes seq to a dense 0..n-1 on every save, so deleting Spanning shifts AD from
  // seq 2 to seq 1. AD was never touched — calling it "reordered" would fabricate a change on the
  // single most common runbook edit.
  const before = [
    s({ seq: 0, systemKey: "m365", title: "M365" }),
    s({ seq: 1, systemKey: "spanning", title: "Spanning" }),
    s({ seq: 2, systemKey: "ad", title: "AD" }),
  ];
  const after = [
    s({ seq: 0, systemKey: "m365", title: "M365" }),
    s({ seq: 1, systemKey: "ad", title: "AD" }), // re-indexed, but still after M365
  ];
  const d = diffRunbookSections(before, after);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].systemKey, "spanning");
  assert.deepEqual(d.reordered, [], "AD kept its position relative to M365 — it did not move");
  assert.equal(d.unchanged, 2);
  assert.equal(summarizeRunbookDiff(d), "−1 section");
});

test("inserting a section at the top does not report the rest as reordered", () => {
  const before = [s({ seq: 0, systemKey: "m365", title: "M365" }), s({ seq: 1, systemKey: "ad", title: "AD" })];
  const after = [
    s({ seq: 0, systemKey: "duo", title: "Duo" }),
    s({ seq: 1, systemKey: "m365", title: "M365" }),
    s({ seq: 2, systemKey: "ad", title: "AD" }),
  ];
  const d = diffRunbookSections(before, after);
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.reordered, [], "M365 and AD kept their relative order");
  assert.equal(summarizeRunbookDiff(d), "+1 section");
});

test("a genuine move is still reported even when a section is also deleted", () => {
  const before = [
    s({ seq: 0, systemKey: "m365", title: "M365" }),
    s({ seq: 1, systemKey: "spanning", title: "Spanning" }),
    s({ seq: 2, systemKey: "ad", title: "AD" }),
  ];
  // Spanning deleted AND AD genuinely moved above M365.
  const after = [s({ seq: 0, systemKey: "ad", title: "AD" }), s({ seq: 1, systemKey: "m365", title: "M365" })];
  const d = diffRunbookSections(before, after);
  assert.equal(d.removed.length, 1);
  assert.equal(d.reordered.length, 2, "M365 and AD really did swap");
});
