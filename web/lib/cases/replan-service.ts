// Re-plan an existing case: re-pull the latest UM (if ServiceNow-sourced), re-derive the user's
// identity from the client's CURRENT username pattern + domain, and re-plan against the client's
// CURRENT systems — replacing the planned jobs. The review→adjust→re-plan loop: an engineer can
// tweak the client's systems (Edit systems) or the requester can edit the ticket, then re-plan to
// regenerate the playbook. Only allowed BEFORE execution starts.
import type { PrismaClient } from "@prisma/client";
import { planCase } from "../orchestrator";
import { deriveIdentity } from "../servicenow/intake-mapper";
import { fetchNormalizedIntake } from "./import-service";
import { makeCaseRepository } from "./repository";
import { deriveStatus, type PlanOutcome } from "./planning-service";
import { CaseAlreadyStartedError } from "./job-status";
import { makeEmailDomainResolver } from "./plan-domain";
import { resolvePlannedConfigs, personaSystemKeys } from "../profiles/plan-resolve";
import { resolveActor, type ActorInput } from "../auth/actor";

export type ReplanResult =
  | { ok: true; outcome: PlanOutcome; refreshedFromServiceNow: boolean; mode: "full" | "incremental"; kept: number; added: number; rerun: number }
  | { ok: false; error: string; code: "not_found" | "already_started" };

// `actor` is an AuditActor (label + User FK) for an operator-driven re-plan; a bare string for the
// system callers that also re-plan (they carry no userId, by design).
export async function replanCase(db: PrismaClient, caseId: string, actor: ActorInput, override?: string): Promise<ReplanResult> {
  const repo = makeCaseRepository(db);
  const info = await repo.replanInputs(caseId);
  if (!info) return { ok: false, error: "case not found", code: "not_found" };
  // A started case is fine: replanCaseJobs runs INCREMENTALLY (finished/in-flight jobs are kept;
  // only systems without a kept job get fresh jobs) — so KB/system changes can be picked up
  // mid-run. The only hard stop is the action flipping (guarded in the transaction).

  let action = info.action;
  let payload = info.payload;
  let refreshedFromServiceNow = false;

  // Re-pull the latest ticket for a ServiceNow-sourced case (UM or INC — the requester may have
  // edited it). Best-effort: a SN outage / unconfigured env must NOT block re-planning against edited
  // local systems — keep the stored action/payload and carry on (refreshedFromServiceNow stays false).
  if (info.serviceNowCaseNumber) {
    try {
      const intake = await fetchNormalizedIntake(info.serviceNowCaseNumber);
      if (intake) {
        action = intake.action;
        payload = intake.payload;
        refreshedFromServiceNow = true;
      }
    } catch {
      // swallow — re-plan proceeds with the stored intake.
    }
  }

  // Re-derive the identity for onboarding from the client's CURRENT username pattern + the resolved
  // EMAIL domain (contact-derived, with any per-case override), falling back to the website domain.
  if (action === "onboard") {
    const identity = (info.client.identity ?? {}) as { usernamePatterns?: string[] | null };
    // Explicit override (request body) wins; else the PERSISTED per-case choice (the operator's
    // domain pick survives later replans); else the client's default resolution.
    const { domain } = await makeEmailDomainResolver(db)(info.client, override ?? info.emailDomainOverride ?? undefined);
    payload = deriveIdentity(payload, { usernamePatterns: identity.usernamePatterns ?? null, primaryDomain: domain });
  }

  const planned = resolvePlannedConfigs(info.client, payload, action,
    planCase(info.client.systems, action, payload, personaSystemKeys(info.client, payload, action),
      new Set(info.client.notNeededSecrets)));
  const status = deriveStatus(planned);
  let result: { mode: "full" | "incremental"; kept: number; added: number; rerun: number };
  try {
    result = await repo.replanCaseJobs(caseId, { action, payload, status }, planned);
  } catch (e) {
    // Only thrown when the ACTION flipped on a started case (onboard<->offboard mid-run).
    if (e instanceof CaseAlreadyStartedError) {
      return { ok: false, error: "the action changed (onboard/offboard) but this case already started — finish or trash it instead of re-planning across actions", code: "already_started" };
    }
    throw e;
  }

  const who = resolveActor(actor);
  await repo.writeAudit({
    actor: who.actor, userId: who.userId, action: "case.replan", clientId: info.client.id, caseRequestId: caseId,
    detail: { refreshedFromServiceNow, action, jobs: planned.length, mode: result.mode, kept: result.kept, added: result.added, rerun: result.rerun },
  });

  return {
    ok: true,
    refreshedFromServiceNow,
    mode: result.mode,
    kept: result.kept,
    added: result.added,
    rerun: result.rerun,
    outcome: {
      caseId, status, jobCount: planned.length,
      manualCount: planned.filter((j) => j.mode !== "api").length,
      approvalCount: planned.filter((j) => j.requiresApproval).length,
    },
  };
}
