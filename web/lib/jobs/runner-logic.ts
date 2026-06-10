// Pure runner-coordination logic (no I/O) — unit-tested in runner-logic.test.ts.
import type { CaseStatus, JobStatus, Mode } from "@prisma/client";

export type JobLite = {
  id: string;
  systemKey: string;
  sequence: number;
  mode: Mode;
  status: JobStatus;
  requiresApproval: boolean;
  approved?: boolean;
  // The system keys this job depends on (persisted into request.dependsOn at plan time).
  // undefined/null = planned before deps were persisted -> strict sequence-order fallback.
  dependsOn?: string[] | null;
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

// The api jobs actually blocking this job. DAG-aware: when the job carries its persisted
// dependsOn, ONLY those systems gate it — independent branches run in parallel (mimecast, which
// depends on m365, doesn't wait for an unrelated egnyte step). Jobs planned before dependsOn was
// persisted fall back to the old strict rule (every earlier api job must finish). Manual
// checklist items never block either way.
export function blockingJobs(job: JobLite, caseJobs: JobLite[]): JobLite[] {
  const unmet = (j: JobLite) => j.mode === "api" && j.status !== "succeeded" && j.status !== "skipped";
  if (Array.isArray(job.dependsOn)) {
    return caseJobs.filter((j) => unmet(j) && job.dependsOn!.includes(j.systemKey));
  }
  return caseJobs.filter((j) => unmet(j) && j.sequence < job.sequence);
}

export function dependencyGateOpen(job: JobLite, caseJobs: JobLite[]): boolean {
  return blockingJobs(job, caseJobs).length === 0;
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
