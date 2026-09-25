// Load and save a case's per-case step selection (FR #173 / #134). See case-steps.ts for the rules.
import type { PrismaClient } from "@prisma/client";
import { planCase } from "../orchestrator";
import { matchIntakeRule } from "../profiles/intake-rules";
import { personaSystemKeys } from "../profiles/plan-resolve";
import { resolveActor, type ActorInput } from "../auth/actor";
import { makeCaseRepository } from "./repository";
import { replanCase, type ReplanResult } from "./replan-service";
import { stepRows, selectionToLists, type StepRow } from "./case-steps";

// The rows for the panel. `natural` is computed the way the planner would plan this case with no
// per-case choice (same persona, secrets, intake rule and backbone inputs as replan-service).
export async function loadCaseSteps(db: PrismaClient, caseId: string): Promise<{ action: string; rows: StepRow[] } | null> {
  const repo = makeCaseRepository(db);
  const info = await repo.replanInputs(caseId);
  if (!info) return null;
  const jobs = await db.job.findMany({ where: { caseRequestId: caseId }, select: { systemKey: true, status: true } });
  const rule = info.action === "onboard" ? matchIntakeRule((info.client as { intakeRules?: unknown }).intakeRules, info.payload) : null;
  const intakeSkipped = new Set<string>(rule?.skipSystems ?? []);
  const natural = new Set(
    planCase(info.client.systems, info.action, info.payload, personaSystemKeys(info.client, info.payload, info.action),
      new Set(info.client.notNeededSecrets), new Set(info.client.wiredOptionalSecrets), intakeSkipped, info.client.backbone)
      .map((j) => j.systemKey)
  );
  const rows = stepRows({
    systems: info.client.systems, action: info.action, natural,
    requested: info.requestedSystems, skipped: info.skippedSystems, intakeSkipped, jobs,
  });
  return { action: info.action, rows };
}

export type SaveStepsResult = { ok: true; requestedSystems: string[]; skippedSystems: string[]; replan: ReplanResult } | { ok: false; status: number; error: string };

// Store the operator's desired set (as differences from natural) and re-plan so the case's jobs follow.
// Locked rows keep their current state whatever the request says: a step that ran can't be removed,
// and an intake-rule skip isn't a per-case choice.
export async function saveCaseSteps(db: PrismaClient, caseId: string, wantRunning: string[], actor: ActorInput): Promise<SaveStepsResult> {
  const loaded = await loadCaseSteps(db, caseId);
  if (!loaded) return { ok: false, status: 404, error: "case not found" };
  const want = new Set(wantRunning);
  for (const r of loaded.rows) {
    if (!r.locked) continue;
    if (r.runs) want.add(r.systemKey); else want.delete(r.systemKey);
  }
  const lists = selectionToLists(loaded.rows, want);
  const before = await db.caseRequest.findUnique({ where: { id: caseId }, select: { requestedSystems: true, skippedSystems: true, clientId: true } });
  await db.caseRequest.update({ where: { id: caseId }, data: lists });
  const who = resolveActor(actor);
  await db.auditLog.create({
    data: {
      actor: who.actor, userId: who.userId, caseRequestId: caseId, clientId: before?.clientId ?? null,
      action: "case.steps.set",
      detail: { before: { requested: before?.requestedSystems ?? [], skipped: before?.skippedSystems ?? [] }, after: { requested: lists.requestedSystems, skipped: lists.skippedSystems } },
    },
  });
  const replan = await replanCase(db, caseId, actor);
  return { ok: true, ...lists, replan };
}
