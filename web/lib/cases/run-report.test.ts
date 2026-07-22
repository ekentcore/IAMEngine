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

test("an auto-retrying step (vendor sync pending) is 'retrying', not a warning/failure", () => {
  const rr = buildRunReport(input({
    jobs: [{
      systemKey: "spanning", sequence: 0, mode: "api", status: "succeeded",
      request: { autoRetry: { at: 2_000_000_900_000, count: 1, firstAt: 2_000_000_000_000 } },
      result: { Actions: ["Spanning has not discovered the user yet — auto-retrying every 15 minutes"] },
      validation: { ok: false, checks: [{ name: "Spanning user present", expected: true, actual: false, pass: false }] },
      error: null, startedAt: null, finishedAt: null,
    }],
    names: new Map([["spanning", "Spanning"]]),
  }));
  assert.equal(rr.steps[0].verdict, "retrying");
  assert.equal(rr.summary.warnings, 0);
  assert.equal(rr.summary.failed, 0);
  assert.equal(rr.summary.running, 1); // folded into the in-progress bucket
  assert.ok(rr.steps[0].autoRetry, "carries the auto-retry schedule");
  assert.equal(rr.steps[0].fingerprint, null, "no run-log outcome — the retry resolves it");
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

// --- offboard target ambiguity: the executor couldn't tell WHICH person to offboard -------------
// The shortlist must reach the run report, or the operator has nothing to pick from and the step is
// just a mysterious failure.
test("a step's offboard candidates are surfaced for the picker", () => {
  const r = buildRunReport(input({
    action: "offboard",
    payload: { userToOffboard: "Parth Shah" },
    jobs: [{
      systemKey: "m365", sequence: 0, mode: "api", status: "failed", request: {},
      result: {
        Actions: ["WARN no exact match for 'Parth Shah' — 2 similar user(s) found; pick the right one on the case. Nothing done."],
        Candidates: [
          { id: "1", upn: "pshah@acme.com", displayName: "Parth K. Shah", jobTitle: "Analyst", department: "Sales", enabled: true },
          { id: "2", upn: "pshah3@acme.com", displayName: "Parthiv Shah", enabled: false },
        ],
        CandidateQuery: "Parth Shah",
        CandidateReason: "no-match",
      },
      validation: null, error: "DECISION_NEEDED:offboard_target | no exact match", startedAt: null, finishedAt: null,
    }],
    names: new Map([["m365", "Microsoft 365"]]),
  }));
  const step = r.steps[0];
  assert.equal(step.offboardCandidates?.reason, "no-match");
  assert.equal(step.offboardCandidates?.query, "Parth Shah");
  assert.equal(step.offboardCandidates?.candidates.length, 2);
  assert.equal(step.offboardCandidates?.candidates[0].displayName, "Parth K. Shah");
  assert.equal(step.offboardCandidates?.candidates[1].enabled, false);
});

test("a clean step carries no candidate picker", () => {
  const r = buildRunReport(input());
  assert.equal(r.steps[0].offboardCandidates, null);
});

// A manual step has no runner result, so it used to render as a bare name with an empty body. Its
// instruction lives in its config — and for the clients whose runbook FORBIDS removing the licence,
// that note is the only thing distinguishing "deliberately left alone" from "the engine silently
// failed to do it", which is exactly the bug this work exists to kill.
test("a manual step surfaces its config note on the run report", () => {
  const r = buildRunReport(input({
    action: "offboard",
    jobs: [{
      systemKey: "license-review", sequence: 0, mode: "manual", status: "manual",
      request: { config: { note: "License NOT removed — this is intentional. Runbook: \"Do NOT remove the license.\"" } },
      result: null, validation: null, error: null, startedAt: null, finishedAt: null,
    }],
    names: new Map([["license-review", "License review"]]),
  }));
  assert.equal(r.steps[0].verdict, "manual");
  assert.match(r.steps[0].actions[0], /intentional/);
  assert.match(r.steps[0].actions[0], /Do NOT remove the license/);
});

test("an api step is unaffected by the manual-note path", () => {
  const r = buildRunReport(input());
  assert.deepEqual(r.steps[0].actions, ["created user jane.doe@acme.com"]);
});

// The pending-blocker line reuses the claim gate (blockingJobs) — the report must agree with what
// the runner will actually do. The old hand-rolled mirror counted ad-hoc jobs as blockers.
test("a pending ad-hoc job is NOT reported as a blocker (the claim gate ignores it)", () => {
  const rr = buildRunReport(input({
    jobs: [
      { systemKey: "m365", sequence: 0, mode: "api", status: "succeeded", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
      // Ad-hoc password reset riding the job table, still pending — invisible to the gate.
      { systemKey: "m365-password-reset", sequence: 1, mode: "api", status: "pending", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
      { systemKey: "mimecast", sequence: 2, mode: "api", status: "pending", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
    ],
    names: new Map([["m365", "Microsoft 365"], ["m365-password-reset", "Password reset (M365)"], ["mimecast", "Mimecast"]]),
    caseStatus: "running",
  }));
  const mimecast = rr.steps.find((s) => s.systemKey === "mimecast");
  assert.equal(mimecast?.pendingReason, "ready — waiting for a runner to claim it");
});

test("an operator-accepted FAILED dependency no longer blocks (matches the claim gate)", () => {
  const rr = buildRunReport(input({
    jobs: [
      { systemKey: "directory-sync", sequence: 0, mode: "api", status: "failed", request: {}, result: null, validation: null, error: "sync broken", startedAt: null, finishedAt: null },
      { systemKey: "mimecast", sequence: 1, mode: "api", status: "pending", request: { dependsOn: ["directory-sync"] }, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
    ],
    names: new Map([["directory-sync", "Entra Connect sync"], ["mimecast", "Mimecast"]]),
    caseStatus: "running",
    acceptedSystemKeys: new Set(["directory-sync"]),
  }));
  const mimecast = rr.steps.find((s) => s.systemKey === "mimecast");
  assert.equal(mimecast?.pendingReason, "ready — waiting for a runner to claim it");
});

test("a real unmet api dependency still reads as a blocker", () => {
  const rr = buildRunReport(input({
    jobs: [
      { systemKey: "m365", sequence: 0, mode: "api", status: "running", request: {}, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
      { systemKey: "mimecast", sequence: 1, mode: "api", status: "pending", request: { dependsOn: ["m365"] }, result: null, validation: null, error: null, startedAt: null, finishedAt: null },
    ],
    names: new Map([["m365", "Microsoft 365"], ["mimecast", "Mimecast"]]),
    caseStatus: "running",
  }));
  const mimecast = rr.steps.find((s) => s.systemKey === "mimecast");
  assert.equal(mimecast?.pendingReason, "waiting for Microsoft 365 to finish first");
});

test("M365 LicenseDependencyIssues surface as step.licenseIssues (held-back plans + how to fix)", () => {
  const rr = buildRunReport(input({
    jobs: [{
      systemKey: "m365", sequence: 0, mode: "api", status: "succeeded", request: {},
      result: {
        Actions: ["assigned license: Microsoft 365 E3", "WARN Microsoft Defender for Office 365 (Plan 2) couldn't be enabled — it requires Exchange Online (Plan 2)"],
        LicenseIncomplete: true,
        LicenseDependencyIssues: [{
          SkuId: "sku-atp", SkuName: "Microsoft Defender for Office 365 (Plan 2)",
          PlanId: "8e0c0a52-6a6c-4d40-8370-dd62790dcd70", PlanName: "Microsoft Defender for Office 365 (Plan 2)",
          Requires: ["efb87545-963c-4e0d-99df-69c6916d9eb0"], RequiresNames: ["Exchange Online (Plan 2)"],
          Resolution: "Microsoft Defender for Office 365 (Plan 2) couldn't be enabled — it requires Exchange Online (Plan 2), which this user doesn't have. Add/enable a prerequisite license, then retry the license assignment to turn it on.",
        }],
      },
      validation: { ok: true, checks: [{ name: "user exists", pass: true }] }, error: null, startedAt: null, finishedAt: null,
    }],
    names: new Map([["m365", "Microsoft 365"]]),
  }));
  const issues = rr.steps[0].licenseIssues;
  assert.ok(issues, "licenseIssues parsed");
  assert.equal(issues!.length, 1);
  assert.equal(issues![0].plan, "Microsoft Defender for Office 365 (Plan 2)");
  assert.deepEqual(issues![0].requires, ["Exchange Online (Plan 2)"]);
  assert.match(issues![0].resolution, /retry the license assignment/);
});

test("no LicenseDependencyIssues => step.licenseIssues is null", () => {
  const rr = buildRunReport(input());
  assert.equal(rr.steps[0].licenseIssues, null);
});
