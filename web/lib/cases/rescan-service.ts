// Rescan a case's intake: re-pull the latest ServiceNow ticket (UM or INC) and REFRESH the stored
// intake fields, WITHOUT re-planning. The operator reviews the refreshed "Intake details" and then
// clicks Re-plan to regenerate the playbook on the new fields. The split (refresh vs re-plan) keeps
// each step reviewable — you see what the requester changed before the plan moves.
import type { PrismaClient } from "@prisma/client";
import { fetchNormalizedIntake } from "./import-service";
import { makeCaseRepository } from "./repository";
import { resolveActor, type ActorInput } from "../auth/actor";

export type RescanResult =
  | { ok: true; changed: string[]; actionChanged: boolean; caseNumber: string }
  | { ok: false; error: string; code: "not_found" | "not_servicenow" | "gone_from_sn" | "action_flip_started" };

export async function rescanCaseIntake(db: PrismaClient, caseId: string, actor: ActorInput): Promise<RescanResult> {
  const repo = makeCaseRepository(db);
  const info = await repo.replanInputs(caseId);
  if (!info) return { ok: false, error: "case not found", code: "not_found" };
  if (!info.serviceNowCaseNumber) {
    return { ok: false, error: "this case wasn't imported from ServiceNow — there's nothing to rescan", code: "not_servicenow" };
  }

  const intake = await fetchNormalizedIntake(info.serviceNowCaseNumber);
  if (!intake) {
    return { ok: false, error: `couldn't read ${info.serviceNowCaseNumber} from ServiceNow (deleted, or no longer a user on/off-boarding case)`, code: "gone_from_sn" };
  }

  const res = await repo.refreshCaseIntake(caseId, { action: intake.action, payload: intake.payload, subject: intake.subject });
  if (!res.ok) {
    if (res.reason === "action_flip_started") {
      return { ok: false, error: "the ticket flipped onboard/offboard but this case already started — finish or trash it instead of rescanning across actions", code: "action_flip_started" };
    }
    return { ok: false, error: "case not found", code: "not_found" };
  }

  const who = resolveActor(actor);
  await repo.writeAudit({
    actor: who.actor, userId: who.userId, action: "case.intake.rescan", clientId: res.clientId, caseRequestId: caseId,
    detail: { caseNumber: info.serviceNowCaseNumber, changed: res.changed, actionChanged: res.actionChanged },
  });
  return { ok: true, changed: res.changed, actionChanged: res.actionChanged, caseNumber: info.serviceNowCaseNumber };
}
