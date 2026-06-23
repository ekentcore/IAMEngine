import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport, jobWarningLines, jobOutcome, renderRunReportMarkdown, type BuildRunReportInput } from "./run-report";
import { buildResolutionNote } from "./resolution-note";

function input(overrides: Partial<BuildRunReportInput> = {}): BuildRunReportInput {
  return {
    caseId: "case-1",
    caseNumber: "UM0028740",
    subject: "ONB - Jane Doe",
    action: "onboard",
    caseStatus: "completed",
    client: { name: "Acme", slug: "acme" },
    payload: { userPrincipalName: "jane.doe@acme.com" },
    jobs: [
      { systemKey: "m365", sequence: 0, mode: "api", status: "succeeded", request: {}, result: { Actions: ["created user jane.doe@acme.com"] }, validation: { ok: true, checks: [{ name: "user exists", pass: true }] }, error: null, startedAt: new Date("2026-06-02T10:00:00Z"), finishedAt: new Date("2026-06-02T10:01:00Z") },
      { systemKey: "mimecast", sequence: 1, mode: "api", status: "succeeded", request: {}, result: { Actions: ["WARN internal domain not found"] }, validation: { ok: false, checks: [{ name: "internal domain verified", expected: true, actual: false, pass: false }] }, error: null, startedAt: new Date("2026-06-02T10:01:00Z"), finishedAt: new Date("2026-06-02T10:02:00Z") },
      { systemKey: "adobe", sequence: 2, mode: "api", status: "failed", request: {}, result: null, validation: null, error: "token expired", startedAt: null, finishedAt: new Date("2026-06-02T10:03:00Z") },
      { systemKey: "welcome-letter", sequence: 3, mode: "manual", status: "manual", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
    ],
    names: new Map([["m365", "Microsoft 365"], ["mimecast", "Mimecast"], ["adobe", "Adobe"], ["welcome-letter", "Welcome letter"]]),
    ...overrides,
  };
}

test("succeeded + validation ok => verified; succeeded + validation miss => warning", () => {
  const rr = buildRunReport(input());
  assert.equal(rr.steps[0].verdict, "verified");
  assert.equal(rr.steps[1].verdict, "warning"); // succeeded but validation.ok === false
  assert.equal(rr.steps[2].verdict, "failed");
  assert.equal(rr.steps[3].verdict, "manual");
});

test("summary tallies each verdict", () => {
  const rr = buildRunReport(input());
  assert.deepEqual(rr.summary, { succeeded: 1, warnings: 1, failed: 1, skipped: 0, manual: 1, needsApproval: 0, pending: 0, running: 0 });
});

test("succeeded + validation ok but a WARN action => warning (not a clean verified)", () => {
  const rr = buildRunReport(input({
    jobs: [{ systemKey: "m365", sequence: 0, mode: "api", status: "succeeded", request: {}, result: { Actions: ["assigned license: E5", "WARN could not add to E5 Entra group: group not found"] }, validation: { ok: true, checks: [{ name: "user exists", pass: true }] }, error: null, startedAt: null, finishedAt: null }],
    names: new Map([["m365", "Microsoft 365"]]),
  }));
  assert.equal(rr.steps[0].verdict, "warning");
});

test("a pending approval-gated job surfaces as needs_approval", () => {
  const rr = buildRunReport(input({
    jobs: [{ systemKey: "ad", sequence: 0, mode: "api", status: "pending", request: { requiresApproval: true, approved: false }, result: null, validation: null, error: null, startedAt: null, finishedAt: null }],
    names: new Map([["ad", "AD"]]),
  }));
  assert.equal(rr.steps[0].verdict, "needs_approval");
});

test("buildResolutionNote lists each step's actions, excludes case-resolution, and flags follow-ups", () => {
  const note = buildResolutionNote(buildRunReport(input({
    jobs: [
      { systemKey: "m365", sequence: 0, mode: "api", status: "succeeded", request: {}, result: { Actions: ["created user jane.doe@acme.com", "assigned E5"] }, validation: { ok: true, checks: [] }, error: null, startedAt: null, finishedAt: null },
      { systemKey: "adobe", sequence: 1, mode: "api", status: "failed", request: {}, result: null, validation: null, error: "token expired", startedAt: null, finishedAt: null },
      { systemKey: "hardware", sequence: 2, mode: "manual", status: "manual", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
      { systemKey: "case-resolution", sequence: 3, mode: "manual", status: "manual", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
    ],
    names: new Map([["m365", "Microsoft 365"], ["adobe", "Adobe"], ["hardware", "Hardware"], ["case-resolution", "Case resolution"]]),
  })));
  assert.match(note, /Microsoft 365: created user jane\.doe@acme\.com; assigned E5/);
  assert.match(note, /✋ Hardware: completed by hand/);
  assert.match(note, /Follow-ups/);
  assert.match(note, /Adobe: token expired/);
  assert.doesNotMatch(note, /Case resolution/); // the resolution step itself is excluded
});

test("markdown surfaces actions, validation misses, and errors", () => {
  const md = renderRunReportMarkdown(buildRunReport(input()));
  assert.match(md, /# Run report/);
  assert.match(md, /created user jane\.doe@acme\.com/);
  assert.match(md, /⚠️ warning/);
  assert.match(md, /✗ internal domain verified/);
  assert.match(md, /Error: token expired/);
});

test("jobWarningLines collects WARN actions and missed validation checks", () => {
  const lines = jobWarningLines(
    { Actions: ["created user", "license: WARN no available seats — open a Procurement Case"] },
    { ok: false, checks: [{ name: "backup enabled", expected: true, actual: false, pass: false }, { name: "user present", expected: true, actual: true, pass: true }] }
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /WARN no available seats/);
  assert.equal(lines[1], "validation missed: backup enabled");
});

test("jobWarningLines is empty for a clean result", () => {
  assert.deepEqual(jobWarningLines({ Actions: ["created user"] }, { ok: true, checks: [] }), []);
  assert.deepEqual(jobWarningLines(null, null), []);
});

test("jobOutcome: clean success -> verified, no messages", () => {
  const o = jobOutcome("succeeded", { Actions: ["created user"] }, { ok: true, checks: [] }, null);
  assert.equal(o.verdict, "verified");
  assert.deepEqual(o.messages, []);
});

test("jobOutcome: a succeeded result with a WARN action is a warning, message captured", () => {
  const o = jobOutcome("succeeded", { Actions: ["license: WARN no available seats"] }, { ok: true, checks: [] }, null);
  assert.equal(o.verdict, "warning");
  assert.match(o.messages[0], /WARN no available seats/);
});

test("jobOutcome: a failed result captures the error first, then any warnings", () => {
  const o = jobOutcome("failed", { Actions: ["WARN partial"] }, null, "Insufficient privileges");
  assert.equal(o.verdict, "failed");
  assert.equal(o.messages[0], "Insufficient privileges");
  assert.match(o.messages[1], /WARN partial/);
});

test("jobOutcome: a passed validation but missed check still reads as warning", () => {
  const o = jobOutcome("succeeded", { Actions: ["added groups"] }, { ok: false, checks: [{ name: "group: TEAMDCG", expected: true, actual: false, pass: false }] }, null);
  assert.equal(o.verdict, "warning");
  assert.match(o.messages[0], /validation missed: group: TEAMDCG/);
});
