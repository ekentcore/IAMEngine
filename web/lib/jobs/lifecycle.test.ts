// End-to-end loop test (no DB): a planned case is driven to a terminal status through the
// SAME pure functions the real runner-service uses — planCase (orchestrator), isClaimable +
// deriveCaseStatus (runner-logic), simulateJob (sim-executor) — then aggregated by
// buildRunReport. This proves the brain runs onboarding/offboarding cases to completion and
// that an `api` system with no executor resolves as `skipped`, never failing the case.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientSystem, JobStatus, Mode } from "@prisma/client";
import { planCase } from "../orchestrator";
import { deriveCaseStatus, isClaimable, type JobLite } from "./runner-logic";
import { simulateJob } from "./sim-executor";
import { buildRunReport } from "../cases/run-report";
import type { Action } from "../automation";
import type { RunnerJob } from "./types";

function sys(over: Partial<ClientSystem>): ClientSystem {
  return {
    id: "id", clientId: "c", systemKey: "m365", mode: "api",
    onboardWhen: "always", offboardWhen: "always",
    dependsOn: [], requiresApproval: false, captureEvidence: false,
    secretNames: [], config: null,
    ...over,
  } as unknown as ClientSystem;
}

// In-memory mirror of a persisted Job row (see repository.createCaseWithJobs).
type MemJob = {
  id: string; systemKey: string; sequence: number; mode: Mode; status: JobStatus;
  requiresApproval: boolean; approved: boolean;
  request: unknown; result: unknown; validation: unknown; error: string | null;
  startedAt: Date | null; finishedAt: Date | null;
};

const client = { slug: "c", primaryDomain: "c.com", backbone: null } as const;

// Run the full claim -> simulate -> record loop in memory, returning the final case status,
// the order systems executed in, and the after-action run report.
function simulateCase(systems: ClientSystem[], action: Action, payload: Record<string, unknown>, opts: { autoApprove?: boolean } = {}) {
  const autoApprove = opts.autoApprove ?? true;
  const planned = planCase(systems, action, payload);
  const jobs: MemJob[] = planned.map((p, i) => ({
    id: `j${i}`, systemKey: p.systemKey, sequence: p.sequence, mode: p.mode,
    status: p.mode === "api" ? "pending" : "manual",
    requiresApproval: p.requiresApproval, approved: false,
    request: { config: p.config ?? null, requiresApproval: p.requiresApproval },
    result: null, validation: null, error: null, startedAt: null, finishedAt: null,
  }));

  const lite = (j: MemJob): JobLite => ({ id: j.id, systemKey: j.systemKey ?? j.id, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: j.requiresApproval, approved: j.approved });
  const order: string[] = [];

  for (let round = 0; round < 200; round++) {
    const all = jobs.map(lite);
    const caseStatus = deriveCaseStatus(all);
    const claimable = jobs.filter((j) => j.mode === "api" && j.status === "pending" && isClaimable(lite(j), all, caseStatus));
    if (claimable.length > 0) {
      const j = claimable.sort((a, b) => a.sequence - b.sequence)[0];
      const runnerJob: RunnerJob = {
        id: j.id, caseNumber: null, action, systemKey: j.systemKey, mode: j.mode, client,
        config: (j.request as { config?: unknown }).config ?? null, secretNames: [],
        payload, requiresApproval: j.requiresApproval, captureEvidence: false, dryRun: false, validateOnly: false,
      };
      const r = simulateJob(runnerJob);
      j.status = r.status; j.result = r.result ?? null; j.validation = r.validation ?? null; j.error = r.error ?? null;
      j.startedAt = new Date(); j.finishedAt = new Date();
      order.push(j.systemKey);
      continue;
    }
    // Nothing claimable: clear approval gates if asked, else we've reached a terminal state.
    const gated = jobs.filter((j) => j.mode === "api" && j.status === "pending" && j.requiresApproval && !j.approved);
    if (autoApprove && gated.length > 0) { for (const j of gated) j.approved = true; continue; }
    break;
  }

  const caseStatus = deriveCaseStatus(jobs.map(lite));
  const report = buildRunReport({
    caseId: "case", caseNumber: null, subject: null, action, caseStatus, client: { name: "C", slug: "c" },
    payload, jobs, names: new Map(jobs.map((j) => [j.systemKey, j.systemKey])),
  });
  return { caseStatus, order, report, jobs };
}

test("entra onboard runs api steps, skips unsupported, leaves a manual checklist item", () => {
  const systems = [
    sys({ systemKey: "m365" }),
    sys({ systemKey: "exchange" }),
    sys({ systemKey: "servicenow" }),            // api but no executor -> skipped
    sys({ systemKey: "welcome-letter", mode: "manual" }),
  ];
  const { caseStatus, report } = simulateCase(systems, "onboard", {});
  assert.equal(caseStatus, "needs_manual");
  assert.notEqual(caseStatus, "failed");
  assert.equal(report.summary.succeeded, 2); // m365 + exchange verified
  assert.equal(report.summary.skipped, 1);   // servicenow (framework, no executor)
  assert.equal(report.summary.manual, 1);    // welcome-letter
  assert.equal(report.summary.failed, 0);
});

test("ad-synced offboard: approval-gated until approved, then completes in dependency order", () => {
  const systems = [
    sys({ systemKey: "active-directory", requiresApproval: true }),
    sys({ systemKey: "directory-sync", dependsOn: ["active-directory"] }),
    sys({ systemKey: "exchange", dependsOn: ["active-directory"] }),
  ];
  // Without approval the case stalls on the gate: AD never runs and the case never completes
  // (its dependents stay dependency-blocked behind the gated step).
  const blocked = simulateCase(systems, "offboard", {}, { autoApprove: false });
  assert.notEqual(blocked.caseStatus, "completed");
  assert.notEqual(blocked.caseStatus, "failed");
  assert.equal(blocked.jobs.find((j) => j.systemKey === "active-directory")!.status, "pending");
  assert.equal(blocked.order.length, 0); // nothing executed

  // With approval the whole chain runs to completion, AD before its dependents.
  const done = simulateCase(systems, "offboard", {});
  assert.equal(done.caseStatus, "completed");
  assert.equal(done.report.summary.succeeded, 3);
  assert.equal(done.report.summary.failed, 0);
  assert.ok(done.order.indexOf("active-directory") < done.order.indexOf("directory-sync"));
  assert.ok(done.order.indexOf("active-directory") < done.order.indexOf("exchange"));
});

test("a case of only-unsupported api systems completes via skips, never fails", () => {
  // servicenow + case-resolution are framework systems with no executor (entra is now aliased
  // to the M365 executor, so it is no longer unsupported).
  const systems = [sys({ systemKey: "servicenow" }), sys({ systemKey: "case-resolution" })];
  const { caseStatus, report } = simulateCase(systems, "onboard", {});
  assert.equal(caseStatus, "completed");
  assert.equal(report.summary.skipped, 2);
  assert.equal(report.summary.succeeded, 0);
  assert.equal(report.summary.failed, 0);
});
