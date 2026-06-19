// Plan a case into Job rows. Reuses the existing orchestrator (lib/orchestrator.planCase)
// for lane filtering + topo-sort; this service persists the result and sets case status.
import type { CaseStatus } from "@prisma/client";
import { planCase, type PlannedJob } from "../orchestrator";
import { deriveIdentity } from "../servicenow/intake-mapper";
import type { CaseRepository } from "./repository";
import type { NewCaseInput } from "./types";
import type { ResolveClient } from "../clients/email-domain";
import { resolvePlannedConfigs } from "../profiles/plan-resolve";
import { resolveUnknownsWithAI } from "./ai-resolve";

export type PlanOutcome = {
  caseId: string;
  status: CaseStatus;
  jobCount: number;
  manualCount: number;
  approvalCount: number;
};

// Derive the case's post-planning status from the planned jobs.
export function deriveStatus(jobs: PlannedJob[]): CaseStatus {
  if (jobs.some((j) => j.requiresApproval)) return "needs_approval";
  if (jobs.some((j) => j.mode === "api")) return "queued"; // ready to dispatch (no runners yet)
  return "needs_manual"; // only manual/browser steps
}

export async function createAndPlanCase(
  repo: CaseRepository,
  input: NewCaseInput,
  actor: string,
  // Optional: resolve the email/UPN domain from the client's ServiceNow contacts (+ per-case
  // override). When omitted (e.g. manual cases) the cached emailDomain or website domain is used.
  opts?: { resolveDomain?: (client: ResolveClient) => Promise<string> }
): Promise<PlanOutcome> {
  const client = await repo.clientForPlanning(input.clientSlug);
  if (!client) throw new Error(`client not found: ${input.clientSlug}`);

  // For onboarding, derive the user's identity (UPN/SamAccountName/work email) from the client's
  // username pattern + EMAIL domain so the runner modules receive ready-to-use fields. Prefer the
  // contact-derived emailDomain over the website-derived primaryDomain; a resolver (when supplied)
  // refreshes it from contacts and applies any per-case override. Offboarding identifies an
  // existing user, so no derivation is needed.
  const identity = (client.identity ?? {}) as { usernamePatterns?: string[] | null };
  // Offboarding identifies an EXISTING user — the executors resolve them by UPN/email when the
  // intake carries one, else by DISPLAY NAME against the live directory (more reliable than guessing
  // a UPN from a username pattern). So no identity derivation here for offboard.
  let domain = client.emailDomain ?? client.primaryDomain;
  if (input.action === "onboard" && opts?.resolveDomain) domain = await opts.resolveDomain(client);
  let payload =
    input.action === "onboard"
      ? deriveIdentity(input.payload, {
          usernamePatterns: identity.usernamePatterns ?? null,
          primaryDomain: domain,
        })
      : input.payload;

  // LLM last resort: before holding the case for unknowns, let the AI take a confident guess at the
  // fields the deterministic mapping couldn't resolve (marked AI-derived for an operator to confirm).
  if (input.action === "onboard" && Array.isArray((payload as { unknownFields?: unknown }).unknownFields) && (payload as { unknownFields: unknown[] }).unknownFields.length > 0) {
    const ai = await resolveUnknownsWithAI(payload as Record<string, unknown>);
    payload = ai.payload;
  }

  // Plan, then (for v2.1 clients) flatten persona/globals/location config into each onboard job.
  const planned = resolvePlannedConfigs(client, payload, input.action, planCase(client.systems, input.action, payload));
  const status = deriveStatus(planned);
  const caseId = await repo.createCaseWithJobs({ ...input, payload }, client.id, planned, status);

  // Autonomy gate: if the intake left fields it couldn't determine, HOLD the case as "Needs
  // Information" instead of running with guesses — an operator fills them in to release it.
  const unknownFields = Array.isArray((payload as { unknownFields?: unknown }).unknownFields) ? (payload as { unknownFields: unknown[] }).unknownFields : [];
  if (input.action === "onboard" && unknownFields.length > 0) {
    await repo.setHold(caseId, "needs_info");
  }

  // Offboards may be scheduled for a future date — never auto-dispatch on import. Hold the case as
  // "scheduled" so its jobs aren't claimed until an operator resumes it (when the offboard date
  // arrives). A dry-run preview is exempt — the operator wants to see it run read-only now.
  if (input.action === "offboard" && !input.dryRun) {
    await repo.setHold(caseId, "scheduled");
  }

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
