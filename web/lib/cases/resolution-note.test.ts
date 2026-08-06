// FR #0000046: the resolution note was one wall of semicolons. These tests pin the two rules that
// make it readable — one action per line, and trimming the runner's explanatory tails — and, just as
// importantly, pin what must NOT be lost. A work note is the permanent record on the ticket; making
// it shorter must never make it say something untrue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResolutionNote, condenseAction } from "./resolution-note";
import type { RunReport, RunReportStep } from "./run-report";

function step(over: Partial<RunReportStep>): RunReportStep {
  return {
    seq: 1, systemKey: "m365", systemName: "Microsoft 365", status: "succeeded", verdict: "verified",
    actions: [], validation: null, error: null, finishedAt: null, currentPhase: null,
    lastProgressAt: null, autoStopped: false, phaseTrail: [], manualCompleted: false,
    fingerprint: null, accepted: false, procurement: null, autoRetry: null, licenseOptions: null,
    ...over,
  } as RunReportStep;
}

function report(steps: RunReportStep[]): RunReport {
  return {
    caseId: "c1", caseNumber: "UM0030053", subject: null, action: "onboard",
    client: { name: "Drake Star Securities LLC", slug: "drake-star" },
    caseStatus: "needs_manual", verifiedAt: null, verifying: false,
    credsMissing: [], needsInfo: null, aiResolved: null,
    user: "ashwin.bharadwaj@drakestar.com",
    summary: { succeeded: 4, warnings: 0, failed: 0, skipped: 0, manual: 2 },
    steps,
  } as unknown as RunReport;
}

// ---------------------------------------------------------------- condenseAction

test("an explanatory tail after a top-level em dash is dropped", () => {
  assert.equal(
    condenseAction("distribution/mail-enabled 'DrakeStar - USA' — added by the Exchange step (Graph can't); not present yet"),
    "distribution/mail-enabled 'DrakeStar - USA'",
  );
  assert.equal(
    condenseAction("user exists (ashwin.bharadwaj@drakestar.com) — our account (re-run), skipped create"),
    "user exists (ashwin.bharadwaj@drakestar.com)",
  );
});

test("a hyphen inside a group name is not mistaken for the em dash", () => {
  // 'DrakeStar - USA' uses a HYPHEN. Cutting there would rename the client's distribution list.
  assert.equal(condenseAction("mirrored group: DrakeStar - USA"), "mirrored group: DrakeStar - USA");
});

test("an em dash INSIDE parentheses is not a tail — the parenthetical is the content", () => {
  const a = "reset password for ashwin.bharadwaj@drakestar.com (change at next sign-in NOT required — operator choice; shown once to the operator, never stored)";
  assert.equal(condenseAction(a), a);
});

test("a raw API dump is cut, leaving the human clause", () => {
  assert.equal(
    condenseAction("couldn't trigger directory sync: Mimecast API: POST https://api.services.mimecast.com/api/directory/execute-sync -> request failed"),
    "couldn't trigger directory sync",
  );
});

test("an ordinary colon list is kept — it carries the facts", () => {
  assert.equal(condenseAction("set profile: OfficeLocation, JobTitle"), "set profile: OfficeLocation, JobTitle");
  assert.equal(condenseAction("license present: Microsoft 365 Business Premium"), "license present: Microsoft 365 Business Premium");
});

test("condensing never returns empty — a line with nothing but a tail keeps its original", () => {
  assert.equal(condenseAction("— just a tail"), "— just a tail");
  assert.equal(condenseAction("   "), "");
});

// ---------------------------------------------------------------- buildResolutionNote

test("each action gets its own line instead of a semicolon run", () => {
  const note = buildResolutionNote(report([
    step({ actions: ["user exists (a@b.com)", "set profile: OfficeLocation, JobTitle", "set manager: Mohit Pareek"] }),
  ]));
  const lines = note.split("\n");
  // First action rides the step line; the rest are indented under it.
  assert.ok(lines.some((l) => l === "  ✓ Microsoft 365: user exists (a@b.com)"), note);
  assert.ok(lines.some((l) => l.trim() === "set profile: OfficeLocation, JobTitle"), note);
  assert.ok(lines.some((l) => l.trim() === "set manager: Mohit Pareek"), note);
  // and no line crams two actions together
  assert.ok(!note.includes("JobTitle; set manager"), note);
});

test("duplicate lines collapse once their tails are trimmed", () => {
  // Two DLs that differ ONLY in their explanatory tail say the same thing once trimmed.
  const note = buildResolutionNote(report([
    step({ actions: ["group 'X' — added by the Exchange step (Graph can't)", "group 'X' — not present yet"] }),
  ]));
  assert.equal(note.split("\n").filter((l) => l.includes("group 'X'")).length, 1, note);
});

test("WARN actions stay out of the step list and become follow-ups, condensed", () => {
  const note = buildResolutionNote(report([
    step({
      systemKey: "mimecast", systemName: "Mimecast", verdict: "warning",
      actions: [
        "directory-sync connections: 1",
        "WARN couldn't trigger directory sync: Mimecast API: POST https://api.services.mimecast.com/x -> request failed",
      ],
    }),
  ]));
  assert.ok(note.includes("Follow-ups / notes:"), note);
  assert.ok(note.includes("  - Mimecast: couldn't trigger directory sync"), note);
  assert.ok(!note.includes("api.services.mimecast.com"), note);
  // the non-WARN action is still reported as something the step did
  assert.ok(note.includes("directory-sync connections: 1"), note);
});

test("the header, summary and manual/skipped wording are unchanged", () => {
  const note = buildResolutionNote(report([
    step({ systemKey: "egnyte", systemName: "Egnyte", verdict: "manual", actions: [] }),
    step({ systemKey: "adobe", systemName: "Adobe", verdict: "skipped", actions: [] }),
  ]));
  assert.ok(note.startsWith("iam-engine onboard — Drake Star Securities LLC — ashwin.bharadwaj@drakestar.com"), note);
  assert.ok(note.includes("Case UM0030053 · status needs_manual"), note);
  assert.ok(note.includes("Summary: 4 verified, 0 warning, 0 failed, 0 skipped, 2 manual."), note);
  assert.ok(note.includes("  ✋ Egnyte: completed by hand"), note);
  assert.ok(note.includes("  – Adobe: not applicable"), note);
});

test("the case-resolution step itself is still excluded", () => {
  const note = buildResolutionNote(report([
    step({ systemKey: "case-resolution", systemName: "Case resolution", actions: ["wrote the note"] }),
    step({ actions: ["did a thing"] }),
  ]));
  assert.ok(!note.includes("Case resolution"), note);
  assert.ok(!note.includes("wrote the note"), note);
});
