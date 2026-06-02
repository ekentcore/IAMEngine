// Simulated executor — the in-process analog of runner/Start-IamRunner.ps1. It mirrors the
// runner's contract (consumes a RunnerJob, returns a ResultInput) but performs no real work:
// a job for a supported system "succeeds" with a passing validation read-back, and a job for
// a system with no executor resolves as `skipped` (a manual follow-up), never `failed`.
//
// `simulateJob` is pure and unit-tested. `runCaseSimulation` drives the *real* runner-service
// against a dev DB so a whole case can be watched running to a terminal status without a
// PowerShell runner, live tenants, or Delinea (see scripts/sim-run-case.ts).
import type { PrismaClient } from "@prisma/client";
import { hasExecutor, validationChecks, type Action } from "../automation";
import type { RunnerService } from "./runner-service";
import type { ResultInput, RunnerJob } from "./types";

// Produce the result a real executor would post for this job — without touching any tenant.
export function simulateJob(job: RunnerJob): ResultInput {
  if (!hasExecutor(job.systemKey)) {
    return { status: "skipped", error: `no executor for ${job.systemKey} — manual follow-up` };
  }

  const action = job.action as Action;
  const checks = validationChecks(job.systemKey, action);
  const actions = checks.length ? checks.map((name) => `ensured: ${name}`) : [`simulated ${action}`];

  return {
    status: "succeeded",
    result: { Actions: actions, simulated: true, ...(job.dryRun ? { dryRun: true } : {}) },
    // A real Confirm-Ctg<System> read-back; the simulator marks every modeled check as passing.
    validation: { ok: true, checks: checks.map((name) => ({ name, pass: true })) },
  };
}

// Drive a case to a terminal status through the real runner-service: claim -> simulate ->
// record, approving any approval-gated jobs along the way, until no more jobs can be claimed.
// Returns the final case status. Assumes `agentId` is scoped (client_network) to the case's
// client so claim() only returns that client's jobs.
export async function runCaseSimulation(
  service: RunnerService,
  db: PrismaClient,
  agentId: string,
  caseId: string,
  opts: { autoApprove?: boolean; maxRounds?: number } = {}
): Promise<string> {
  const autoApprove = opts.autoApprove ?? true;
  const maxRounds = opts.maxRounds ?? 200;

  for (let round = 0; round < maxRounds; round++) {
    const jobs = await service.claim(agentId, 25);
    if (jobs.length === 0) {
      // Nothing claimable. If approval-gated work is the only thing left, clear it and retry;
      // otherwise we've reached a terminal/needs-manual state.
      if (autoApprove) {
        const pending = await db.job.findMany({
          where: { caseRequestId: caseId, status: "pending" },
          select: { id: true, request: true },
        });
        const gated = pending.filter((j) => {
          const r = (j.request ?? {}) as { requiresApproval?: boolean; approved?: boolean };
          return r.requiresApproval && !r.approved;
        });
        if (gated.length > 0) {
          for (const j of gated) await service.approveJob(j.id, "sim:auto");
          continue;
        }
      }
      break;
    }
    for (const job of jobs) {
      await service.recordResult(job.id, agentId, simulateJob(job));
    }
  }

  const c = await db.caseRequest.findUnique({ where: { id: caseId }, select: { status: true } });
  return c?.status ?? "unknown";
}
