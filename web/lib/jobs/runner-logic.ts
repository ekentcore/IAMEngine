// Pure runner-coordination logic (no I/O) — unit-tested in runner-logic.test.ts.
import type { CaseStatus, JobStatus, Mode } from "@prisma/client";
import { isAdhocSystemKey } from "./adhoc";

// Ad-hoc operator actions riding the job table (password resets, force-Spanning-sync). They are NOT
// case work: a failed one must not fail the case, a pending one must not read as "still running", and
// one must never gate a real step. Filtered out of every case-level derivation below. The set is
// generalized in ./adhoc so a new ad-hoc action is excluded everywhere at once.
const adhoc = (j: { systemKey: string }) => isAdhocSystemKey(j.systemKey);

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
  // The operator ACCEPTED this step's failure ("ignore warning — mark complete", which resolves its
  // run-log outcome). A failed-but-accepted step counts as satisfied for the dependency gate, so
  // downstream steps proceed (e.g. accept a failed directory-sync -> m365 stops waiting on it).
  accepted?: boolean;
};

const OPEN: JobStatus[] = ["pending", "dispatched", "running"];
// Only "completed" truly blocks claiming. A "failed" case must NOT block its still-pending jobs: a
// failed step (e.g. egnyte) shouldn't strand an unrelated pending step (e.g. m365) — the per-job
// dependency gate already stops a job whose OWN prerequisites didn't succeed, so a failed step can't
// drag a dependent one in.
const TERMINAL_CASE: CaseStatus[] = ["completed"];

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
  // succeeded/skipped satisfy a dependency; so does a failure the operator explicitly ACCEPTED.
  const unmet = (j: JobLite) => j.mode === "api" && j.status !== "succeeded" && j.status !== "skipped" && !j.accepted && !adhoc(j);
  if (Array.isArray(job.dependsOn)) {
    return caseJobs.filter((j) => unmet(j) && job.dependsOn!.includes(j.systemKey));
  }
  return caseJobs.filter((j) => unmet(j) && j.sequence < job.sequence);
}

export function dependencyGateOpen(job: JobLite, caseJobs: JobLite[]): boolean {
  return blockingJobs(job, caseJobs).length === 0;
}

// Priority failover: should THIS runner stand by (claim nothing) because a higher-priority peer of the
// same scope is currently online? LOWER priority number = higher precedence. Only a STRICTLY higher peer
// forces stand-by — equal-priority peers load-balance (the pre-failover behavior). So primary=1 + backup=2
// means the backup idles while the primary heartbeats, and takes over once the primary goes silent.
export function shouldStandBy(myPriority: number, onlinePeerPriorities: number[]): boolean {
  return onlinePeerPriorities.some((p) => p < myPriority);
}

// The case badge. Callers MUST populate JobLite.accepted (see acceptedKeysFor) — an accepted failure
// that arrives here unflagged pins the case at "failed" forever, because accepting an outcome never
// touches Job.status and nothing else re-derives it.
export function deriveCaseStatus(all: JobLite[]): CaseStatus {
  const jobs = all.filter((j) => !adhoc(j));
  // A failure the operator ACCEPTED ("ignore warning — mark complete") is satisfied, exactly as the
  // dependency gate treats it (blockingJobs) and as the run report renders it (verified). Counting it
  // as a failure here is what made the cases list read "failed" on a case whose every step reads green.
  if (jobs.some((j) => j.status === "failed" && !j.accepted)) return "failed";
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

// --- Setup-state dispatch gate -------------------------------------------------------------------
// Opt-in (AppSetting "setup_gate", default OFF): when enforcing, a job whose system's latest
// connection test FAILED is withheld from claim unless an operator attested the credential's
// rights manually. Deliberately narrow: "untested" and "unknown" never block (that would strand
// every legacy client), unwired secrets are already blocked by the credential preflight, and the
// attestation is the single override mechanism — no second flag to disagree with it.
export type SetupGatePolicy = { enforceTested: boolean };
export type SetupGateInput = {
  test: "ok" | "fail" | "untested" | "not_needed" | "unknown";
  attested: boolean;
};
export function setupGateBlocks(input: SetupGateInput, policy: SetupGatePolicy): { block: boolean; reason?: string } {
  if (!policy.enforceTested) return { block: false };
  if (input.test === "fail" && !input.attested) {
    return { block: true, reason: "latest connection test failed and rights are not attested — fix the credential or attest it on the client page" };
  }
  return { block: false };
}
