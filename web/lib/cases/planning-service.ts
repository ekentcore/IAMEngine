// Plan a case into Job rows. Reuses the existing orchestrator (lib/orchestrator.planCase)
// for lane filtering + topo-sort; this service persists the result and sets case status.
import type { CaseStatus } from "@prisma/client";
import { planCase, type PlannedJob } from "../orchestrator";
import { deriveIdentity } from "../servicenow/intake-mapper";
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

  // For onboarding, derive the user's identity (UPN/SamAccountName/work email) from the
  // client's username pattern + primary domain so the runner modules receive ready-to-use
  // fields. Offboarding identifies an existing user, so no derivation is needed.
  const identity = (client.identity ?? {}) as { usernamePatterns?: string[] | null };
  const payload =
    input.action === "onboard"
      ? deriveIdentity(input.payload, {
          usernamePatterns: identity.usernamePatterns ?? null,
          primaryDomain: client.primaryDomain,
        })
      : input.payload;

  const planned = planCase(client.systems, input.action, payload);
  const status = deriveStatus(planned);
  const caseId = await repo.createCaseWithJobs({ ...input, payload }, client.id, planned, status);

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
