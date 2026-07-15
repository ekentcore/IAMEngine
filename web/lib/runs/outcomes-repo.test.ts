import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeFingerprint, groupOutcomes, buildOutcomeWhere, type OutcomeRow } from "./outcomes-repo";

const base = {
  caseRequestId: "case-1",
  systemKey: "m365",
  verdict: "warning",
  messages: ["could not add to group All Users"],
  error: null as string | null,
};

test("the same line for the same case fingerprints identically across re-runs", () => {
  assert.equal(outcomeFingerprint(base), outcomeFingerprint({ ...base }));
});

test("fingerprint changes when case, module, verdict, messages, or error differ", () => {
  const f = outcomeFingerprint(base);
  assert.notEqual(f, outcomeFingerprint({ ...base, caseRequestId: "case-2" }));
  assert.notEqual(f, outcomeFingerprint({ ...base, systemKey: "entra" }));
  assert.notEqual(f, outcomeFingerprint({ ...base, verdict: "failed" }));
  assert.notEqual(f, outcomeFingerprint({ ...base, messages: ["different"] }));
  assert.notEqual(f, outcomeFingerprint({ ...base, error: "boom" }));
});

function row(over: Partial<OutcomeRow> & { fingerprint: string }): OutcomeRow {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    at: over.at ?? new Date(),
    caseRequestId: "case-1",
    caseNumber: "INC1",
    credFailure: over.credFailure ?? null,
    action: "offboard",
    clientName: "Acme",
    systemKey: "m365",
    verdict: "warning",
    status: "ok",
    messages: ["x"],
    error: null,
    validateOnly: false,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

test("groupOutcomes collapses identical fingerprints and counts occurrences, keeping the newest", () => {
  const newest = new Date("2026-06-19T12:00:00Z");
  const older = new Date("2026-06-18T12:00:00Z");
  const rows = [
    row({ id: "a", fingerprint: "fp1", at: newest }),
    row({ id: "b", fingerprint: "fp1", at: older }),
    row({ id: "c", fingerprint: "fp2", at: newest }),
  ];
  const groups = groupOutcomes(rows);
  assert.equal(groups.length, 2);
  const g1 = groups.find((g) => g.fingerprint === "fp1")!;
  assert.equal(g1.count, 2);
  assert.equal(g1.id, "a"); // rows are newest-first, so the latest is kept as the representative
  assert.equal(groups.find((g) => g.fingerprint === "fp2")!.count, 1);
});

test("legacy rows without a fingerprint never collapse together", () => {
  const rows = [row({ id: "a", fingerprint: "" }), row({ id: "b", fingerprint: "" })];
  const groups = groupOutcomes(rows);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.count === 1));
});

test("the default filter hides resolved lines (resolvedAt = null)", () => {
  const where = buildOutcomeWhere({});
  assert.equal(where.resolvedAt, null);
  assert.deepEqual(where.verdict, { in: ["warning", "failed"] });
});

test("includeResolved drops the resolvedAt filter so both open and fixed lines return", () => {
  const where = buildOutcomeWhere({ includeResolved: true });
  assert.ok(!("resolvedAt" in where), "resolvedAt must not be constrained when includeResolved");
});

test("onlyResolved returns just the fixed lines — the always-on source for the v2 Fixed table", () => {
  const where = buildOutcomeWhere({ onlyResolved: true });
  assert.deepEqual(where.resolvedAt, { not: null });
  // still scoped to real problem lines by default, not clean successes
  assert.deepEqual(where.verdict, { in: ["warning", "failed"] });
});
