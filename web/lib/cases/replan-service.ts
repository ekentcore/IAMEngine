// Re-plan an existing case: re-pull the latest UM (if ServiceNow-sourced), re-derive the user's
// identity from the client's CURRENT username pattern + domain, and re-plan against the client's
// CURRENT systems — replacing the planned jobs. The review→adjust→re-plan loop: an engineer can
// tweak the client's systems (Edit systems) or the requester can edit the ticket, then re-plan to
// regenerate the playbook. Only allowed BEFORE execution starts.
import type { PrismaClient } from "@prisma/client";
import { planCase } from "../orchestrator";
import { deriveIdentity, normalizeIntake } from "../servicenow/intake-mapper";
import { snConfigFromEnv } from "../servicenow/gateway";
import { fetchUserManagementCase } from "../servicenow/intake";
import { makeCaseRepository } from "./repository";
import { deriveStatus, type PlanOutcome } from "./planning-service";

export type ReplanResult =
  | { ok: true; outcome: PlanOutcome; refreshedFromServiceNow: boolean }
  | { ok: false; error: string; code: "not_found" | "already_started" };

export async function replanCase(db: PrismaClient, caseId: string, actor: string): Promise<ReplanResult> {
  const repo = makeCaseRepository(db);
  const info = await repo.replanInputs(caseId);
  if (!info) return { ok: false, error: "case not found", code: "not_found" };
  if (info.started) {
    return { ok: false, error: "this case has already started executing — re-plan is only available before dispatch", code: "already_started" };
  }

  let action = info.action;
  let payload = info.payload;
  let refreshedFromServiceNow = false;

  // Re-pull the latest UM for a ServiceNow-sourced case (the requester may have edited it).
  if (info.serviceNowCaseNumber) {
    const raw = await fetchUserManagementCase(snConfigFromEnv(), info.serviceNowCaseNumber);
    if (raw) {
      const intake = normalizeIntake(raw);
      action = intake.action;
      payload = intake.payload;
      refreshedFromServiceNow = true;
    }
  }

  // Re-derive the identity for onboarding from the client's CURRENT username pattern + domain.
  if (action === "onboard") {
    const identity = (info.client.identity ?? {}) as { usernamePatterns?: string[] | null };
    payload = deriveIdentity(payload, { usernamePatterns: identity.usernamePatterns ?? null, primaryDomain: info.client.primaryDomain });
  }

  const planned = planCase(info.client.systems, action, payload);
  const status = deriveStatus(planned);
  await repo.replanCaseJobs(caseId, { action, payload, status }, planned);

  await repo.writeAudit({
    actor, action: "case.replan", clientId: info.client.id, caseRequestId: caseId,
    detail: { refreshedFromServiceNow, action, jobs: planned.length },
  });

  return {
    ok: true,
    refreshedFromServiceNow,
    outcome: {
      caseId, status, jobCount: planned.length,
      manualCount: planned.filter((j) => j.mode !== "api").length,
      approvalCount: planned.filter((j) => j.requiresApproval).length,
    },
  };
}
