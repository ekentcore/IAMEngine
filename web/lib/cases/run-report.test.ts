import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport, renderRunReportMarkdown, type BuildRunReportInput } from "./run-report";

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
  assert.deepEqual(rr.summary, { succeeded: 1, warnings: 1, failed: 1, skipped: 0, manual: 1, needsApproval: 0, pending: 0 });
});

test("a pending approval-gated job surfaces as needs_approval", () => {
  const rr = buildRunReport(input({
    jobs: [{ systemKey: "ad", sequence: 0, mode: "api", status: "pending", request: { requiresApproval: true, approved: false }, result: null, validation: null, error: null, startedAt: null, finishedAt: null }],
    names: new Map([["ad", "AD"]]),
  }));
  assert.equal(rr.steps[0].verdict, "needs_approval");
});

test("markdown surfaces actions, validation misses, and errors", () => {
  const md = renderRunReportMarkdown(buildRunReport(input()));
  assert.match(md, /# Run report/);
  assert.match(md, /created user jane\.doe@acme\.com/);
  assert.match(md, /⚠️ warning/);
  assert.match(md, /✗ internal domain verified/);
  assert.match(md, /Error: token expired/);
});
