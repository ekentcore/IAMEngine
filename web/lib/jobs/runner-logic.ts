// Pure runner-coordination logic (no I/O) — unit-tested in runner-logic.test.ts.
import type { CaseStatus, JobStatus, Mode } from "@prisma/client";

export type JobLite = {
  id: string;
  sequence: number;
  mode: Mode;
  status: JobStatus;
  requiresApproval: boolean;
  approved?: boolean;
};

const OPEN: JobStatus[] = ["pending", "dispatched", "running"];
const TERMINAL_CASE: CaseStatus[] = ["failed", "completed"];

// Whether a pending api job may be dispatched now: its case must be live, an approval gate
// (if any) must be cleared, and all earlier api jobs must have finished. Centralizes the
// claim eligibility rules so claim() can't drift from them.
export function isClaimable(job: JobLite, caseJobs: JobLite[], caseStatus: CaseStatus): boolean {
  if (TERMINAL_CASE.includes(caseStatus)) return false;
  if (job.requiresApproval && !job.approved) return false;
  return dependencyGateOpen(job, caseJobs);
}

// An api job may be claimed only once every earlier api job in its case has reached a
// terminal-success state. This enforces the topo order the orchestrator produced without
// the runner needing the dependency graph (and without blocking on manual checklist items).
export function dependencyGateOpen(job: JobLite, caseJobs: JobLite[]): boolean {
  return caseJobs
    .filter((j) => j.mode === "api" && j.sequence < job.sequence)
    .every((j) => j.status === "succeeded" || j.status === "skipped");
}

export function deriveCaseStatus(jobs: JobLite[]): CaseStatus {
  if (jobs.some((j) => j.status === "failed")) return "failed";
  const openApi = jobs.filter((j) => j.mode === "api" && OPEN.includes(j.status));
  if (openApi.length > 0) {
    // if the only api work left is approval-gated (and not yet approved), surface that
    // rather than "running forever"
    if (openApi.every((j) => j.requiresApproval && !j.approved)) return "needs_approval";
    return "running";
  }
  if (jobs.some((j) => j.status === "manual")) return "needs_manual";
  return "completed";
}
