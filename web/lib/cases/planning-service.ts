// Plan a case into Job rows. Reuses the existing orchestrator (lib/orchestrator.planCase)
// for lane filtering + topo-sort; this service persists the result and sets case status.
import type { CaseStatus } from "@prisma/client";
import { planCase, type PlannedJob } from "../orchestrator";
import type { CaseRepository } from "./repository";
import type { NewCaseInput } from "./types";

export type PlanOutcome = {
  caseId: string;
  status: CaseStatus;
  jobCount: number;
  manualCount: number;
  approvalCount: number;
};

// Derive the case's post-planning status from the planned jobs.
function deriveStatus(jobs: PlannedJob[]): CaseStatus {
  if (jobs.some((j) => j.requiresApproval)) return "needs_approval";
  if (jobs.some((j) => j.mode === "api")) return "queued"; // ready to dispatch (no runners yet)
  return "needs_manual"; // only manual/browser steps
}

export async function createAndPlanCase(
  repo: CaseRepository,
  input: NewCaseInput,
  actor: string
): Promise<PlanOutcome> {
  const client = await repo.clientForPlanning(input.clientSlug);
  if (!client) throw new Error(`client not found: ${input.clientSlug}`);

  const planned = planCase(client.systems, input.action, input.payload);
  const status = deriveStatus(planned);
  const caseId = await repo.createCaseWithJobs(input, client.id, planned, status);

  await repo.writeAudit({
    actor,
    action: "case.plan",
    clientId: client.id,
    caseRequestId: caseId,
    detail: {
      action: input.action,
      jobs: planned.length,
      manual: planned.filter((j) => j.mode !== "api").length,
      approval: planned.filter((j) => j.requiresApproval).length,
      status,
      serviceNowCaseNumber: input.serviceNowCaseNumber ?? null,
    },
  });

  return {
    caseId,
    status,
    jobCount: planned.length,
    manualCount: planned.filter((j) => j.mode !== "api").length,
    approvalCount: planned.filter((j) => j.requiresApproval).length,
  };
}
