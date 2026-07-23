// Server-side "add directory-sync to a client", used by the client-page button and the backfill.
//
// One transaction does all three parts so a partial add can't leave the client half-configured:
//   1. ensure the directory-sync ClientSystem row (so planning runs the step + readiness shows it),
//   2. optionally flip the backbone to ad_synced,
//   3. insert the directory-sync section into the onboard AND offboard runbook, non-destructively —
//      existing sections keep their content; only their seq shifts to make room.
// Every part is idempotent, so re-running (or running over a client that already has the system but
// not the runbook section — the exact gap this fixes) only fills what's missing.
import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveActor, type ActorInput } from "../auth/actor";
import { directorySyncRow, type DirectorySyncOpts } from "./directory-sync-row";
import { planDirectorySyncSectionInsert, directorySyncSectionRow, DIRECTORY_SYNC_KEY } from "./directory-sync-runbook";

export type AddDirectorySyncOpts = {
  orderAfter: DirectorySyncOpts["orderAfter"]; // shapes the SYSTEM row when it must be created
  setAdSynced: boolean; // also set Client.backbone = ad_synced
};

export type AddDirectorySyncResult = {
  clientId: string;
  systemAdded: boolean;
  backboneChanged: boolean;
  sectionsAdded: ("onboard" | "offboard")[];
};

export async function addDirectorySyncToClient(
  db: PrismaClient,
  slug: string,
  opts: AddDirectorySyncOpts,
  actor?: ActorInput
): Promise<AddDirectorySyncResult | null> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true, backbone: true } });
  if (!client) return null;

  const result: AddDirectorySyncResult = {
    clientId: client.id,
    systemAdded: false,
    backboneChanged: false,
    sectionsAdded: [],
  };

  await db.$transaction(async (tx) => {
    // 1. Ensure the directory-sync ClientSystem row (idempotent on the (clientId, systemKey) unique).
    const existing = await tx.clientSystem.findUnique({
      where: { clientId_systemKey: { clientId: client.id, systemKey: DIRECTORY_SYNC_KEY } },
      select: { config: true, dependsOn: true },
    });
    let dsConfig: unknown = existing?.config ?? null;
    let dsDependsOn: string[] = existing?.dependsOn ?? [];
    if (!existing) {
      const row = directorySyncRow(opts);
      await tx.clientSystem.create({
        data: {
          clientId: client.id,
          systemKey: row.systemKey,
          mode: row.mode,
          onboardWhen: row.onboardWhen,
          offboardWhen: row.offboardWhen,
          dependsOn: row.dependsOn,
          requiresApproval: row.requiresApproval,
          captureEvidence: row.captureEvidence,
          secretNames: row.secretNames,
          // DbNull = SQL NULL, matching every other writer of this column (repository.ts). JsonNull
          // would store a JSON `null` literal and read differently under a `config` null filter.
          config: row.config == null ? Prisma.DbNull : (row.config as Prisma.InputJsonValue),
        },
      });
      dsConfig = row.config ?? null;
      dsDependsOn = row.dependsOn;
      result.systemAdded = true;
    }

    // 2. Backbone → ad_synced (only when asked, and not already).
    if (opts.setAdSynced && client.backbone !== "ad_synced") {
      await tx.client.update({ where: { id: client.id }, data: { backbone: "ad_synced" } });
      result.backboneChanged = true;
    }

    // 3. Insert the directory-sync section into each action's runbook, non-destructively.
    // Concurrency: this is a single-operator admin action guarded server-side. Two simultaneous
    // POSTs could in principle both pass the in-transaction alreadyPresent check and double-insert
    // (the (clientId, action, seq) index is not unique). Accepted given the access pattern; the
    // button also disables while saving.
    for (const action of ["onboard", "offboard"] as const) {
      const sections = await tx.runbookSection.findMany({
        where: { clientId: client.id, action },
        select: { seq: true, systemKey: true },
        orderBy: { seq: "asc" },
      });
      // Place the section after the system's dependencies for THIS lane (per-lane override in
      // config.dependsOn.<action>, else the top-level dependsOn) so the documented order matches
      // the executed order — e.g. a hybrid-Exchange client lands directory-sync after Exchange.
      const perLane = (dsConfig as { dependsOn?: Record<string, unknown> } | null)?.dependsOn?.[action];
      const laneDeps = Array.isArray(perLane) && perLane.length ? perLane.map(String) : dsDependsOn;
      const anchorKeys = laneDeps.length ? laneDeps : ["active-directory"];
      const plan = planDirectorySyncSectionInsert(sections, anchorKeys);
      if (plan.alreadyPresent) continue;
      // Inherit the action's KB number so the inserted section matches its siblings' Fetch button.
      const kbRow = await tx.runbookSection.findFirst({
        where: { clientId: client.id, action, NOT: { kbArticle: null } },
        select: { kbArticle: true },
      });
      const body = directorySyncSectionRow(action, dsConfig, kbRow?.kbArticle ?? null);
      // Make room first (shift is a no-op when appending), then insert — never leaves a seq collision.
      if (plan.shiftFromSeq !== null) {
        await tx.runbookSection.updateMany({
          where: { clientId: client.id, action, seq: { gte: plan.shiftFromSeq } },
          data: { seq: { increment: 1 } },
        });
      }
      await tx.runbookSection.create({
        data: {
          clientId: client.id,
          action,
          seq: plan.insertSeq,
          systemKey: body.systemKey,
          title: body.title,
          status: body.status,
          steps: body.steps,
          kbArticle: body.kbArticle,
        },
      });
      result.sectionsAdded.push(action);
    }
  });

  if (result.systemAdded || result.backboneChanged || result.sectionsAdded.length) {
    const who = resolveActor(actor);
    await db.auditLog.create({
      data: {
        actor: who.actor,
        userId: who.userId,
        action: "client.directory_sync.add",
        clientId: client.id,
        detail: {
          systemAdded: result.systemAdded,
          backboneChanged: result.backboneChanged,
          sectionsAdded: result.sectionsAdded,
        },
      },
    });
  }
  return result;
}
