// Integration seam between the change/mover diff engine + planner (change-plan.ts) and the DB
// repository: plan a "change" case (createChangeCase) and apply the operator's chosen removal
// mode once they confirm the preview (confirmChangeCase). Mirrors the create/re-plan split that
// planning-service.ts / replan-service.ts already use for onboard/offboard.
import type { CaseSource } from "@prisma/client";
import type { ChangeDiff, ChangePayload, RemovalMode } from "./change-types";
import { DIRECTORY_SYSTEMS } from "./change-types";
import { computeMoverDiff, deltasToDiff, planChangeJobs, targetGroupsForPersona, type ChangePlanClient } from "./change-plan";
import { deriveStatus, type PlanOutcome } from "./planning-service";
import type { CaseRepository } from "./repository";
import { resolveActor, type ActorInput } from "../auth/actor";

// Thrown by confirmChangeCase when the target case isn't a "change" case — e.g. a fat-fingered
// case id belonging to an onboard/offboard. Caught by the confirm route and mapped to 409, never
// allowed to reach replanCaseJobs (which would overwrite that case's onboard/offboard jobs).
export class NotChangeCaseError extends Error {
  constructor() {
    super("not a change case");
    this.name = "NotChangeCaseError";
  }
}

// Which directory systems are actually active on this client (drives the per-system diffs).
function activeDirectorySystems(client: ChangePlanClient): string[] {
  const present = new Set(client.systems.map((s) => s.systemKey));
  return DIRECTORY_SYSTEMS.filter((k) => present.has(k));
}

// payload -> per-directory diffs. Ad-hoc keeps exchange (dl/sharedMailbox deltas need it); a
// mover NEVER touches exchange — the Change lane's exchange leg only understands DLs/365-groups
// and shared mailboxes, never plain security groups/OU/license, which is all a mover computes.
export function buildChangeDiffs(client: ChangePlanClient, payload: ChangePayload): ChangeDiff[] {
  const dirs = activeDirectorySystems(client);
  if (payload.changeKind === "adhoc") {
    return deltasToDiff(payload.deltas ?? [], dirs);
  }
  const moverDirs = dirs.filter((k) => k !== "exchange"); // exchange = ad-hoc DL/mailbox only in v1
  const { groups, ou } = targetGroupsForPersona(client, payload.toPersona, payload.toLocation);
  // The from-persona's PER-SYSTEM groups (not a flat cross-system union) — a scoped removal on
  // system S must only ever consider what the old persona granted ON S, never what it granted
  // elsewhere. The from-persona's OU is irrelevant here (we're not moving FROM anywhere).
  const { groups: fromGroupsBySystem } = targetGroupsForPersona(client, payload.fromPersona, payload.fromLocation);
  return computeMoverDiff({
    directorySystems: moverDirs,
    targetGroupsBySystem: groups,
    fromManagedGroupsBySystem: fromGroupsBySystem,
    targetOuBySystem: ou,
    removalMode: payload.removalMode ?? "scoped",
  });
}

export type CreateChangeInput = {
  clientSlug: string;
  payload: ChangePayload;
  subject?: string | null;
  serviceNowCaseNumber?: string | null;
  dryRun?: boolean;
  source?: CaseSource;
};

// Plan + create a "change" case. A mover with no confirmed removal mode is held ("review") so the
// preview modal can let the operator choose scoped/full/add-only before anything dispatches — an
// ad-hoc change (hand-picked deltas, no ambiguity to resolve) and a mover that already carries a
// removalMode (e.g. a re-submit) are NOT auto-held here.
export async function createChangeCase(repo: CaseRepository, input: CreateChangeInput, actor: ActorInput): Promise<PlanOutcome> {
  const client = await repo.clientForPlanning(input.clientSlug);
  if (!client) throw new Error(`client not found: ${input.clientSlug}`);

  const diffs = buildChangeDiffs(client, input.payload);
  const planned = planChangeJobs(client, diffs);
  const status = deriveStatus(planned);
  const who = resolveActor(actor);
  const creator = { label: who.actor, userId: who.userId };

  const caseId = await repo.createCaseWithJobs(
    {
      clientSlug: input.clientSlug,
      action: "change",
      subject: input.subject ?? null,
      serviceNowCaseNumber: input.serviceNowCaseNumber ?? null,
      payload: input.payload as unknown as Record<string, unknown>,
      dryRun: input.dryRun ?? false,
      source: input.source ?? "manual",
    },
    client.id,
    planned,
    status,
    creator
  );

  await repo.writeAudit({
    actor: who.actor,
    userId: who.userId,
    action: "case.change.create",
    caseRequestId: caseId,
    clientId: client.id,
    detail: { changeKind: input.payload.changeKind, jobs: planned.length, status },
  });

  if (input.payload.changeKind === "mover" && !input.payload.removalMode) {
    await repo.setHold(caseId, "review");
  }

  return {
    caseId,
    status,
    jobCount: planned.length,
    manualCount: planned.filter((p) => p.mode !== "api").length,
    approvalCount: planned.filter((p) => p.requiresApproval).length,
  };
}

// Apply the operator's chosen removal mode (from the preview modal) to a held mover: recompute
// the diff with that mode and replace the case's planned jobs, then release the review hold.
// Reuses the same replan primitive onboard/offboard re-plans go through (repo.replanCaseJobs) —
// there is no separate "confirm" primitive in the repository, and this case hasn't started
// executing yet (it was held before any job could run), so a full replace is correct here.
export async function confirmChangeCase(repo: CaseRepository, caseId: string, removalMode: RemovalMode, actor: ActorInput): Promise<PlanOutcome> {
  const info = await repo.replanInputs(caseId);
  if (!info) throw new Error(`case not found: ${caseId}`);
  // Guard against confirming a non-change case (wrong/fat-fingered id): replanCaseJobs would
  // otherwise happily replace an onboard/offboard case's jobs with a mover/adhoc change plan.
  if (info.action !== "change") throw new NotChangeCaseError();

  const payload: ChangePayload = { ...(info.payload as unknown as ChangePayload), removalMode };
  const client = info.client as unknown as ChangePlanClient;
  const diffs = buildChangeDiffs(client, payload);
  const planned = planChangeJobs(client, diffs);
  const status = deriveStatus(planned);
  const who = resolveActor(actor);

  await repo.replanCaseJobs(caseId, { action: "change", payload: payload as unknown as Record<string, unknown>, status }, planned);
  await repo.setHold(caseId, null); // release the "review" hold now that the mode is confirmed

  await repo.writeAudit({
    actor: who.actor,
    userId: who.userId,
    action: "case.change.confirm",
    caseRequestId: caseId,
    clientId: info.client.id,
    detail: { removalMode, jobs: planned.length, status },
  });

  return {
    caseId,
    status,
    jobCount: planned.length,
    manualCount: planned.filter((p) => p.mode !== "api").length,
    approvalCount: planned.filter((p) => p.requiresApproval).length,
  };
}
