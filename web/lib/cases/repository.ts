// Thin Prisma wrapper for the cases domain. Factory-style for testability, mirroring
// lib/clients/repository.ts.
import type { PrismaClient, Prisma, ClientSystem, CaseStatus, Action } from "@prisma/client";
import type { PlannedJob } from "../orchestrator";
import type { AuditEntry } from "../clients/types";
import type { CaseDetail, CaseListItem, NewCaseInput, TrashedCaseItem } from "./types";
import { STARTED_STATUSES, hasStartedJobs, CaseAlreadyStartedError } from "./job-status";

// One-line explanation of a case's status, for the list hover tooltip. Reads the case's jobs the
// same way deriveCaseStatus / the dependency gate do, so the hint matches the badge.
type HintJob = { systemKey: string; sequence: number; status: string; mode: string; error: string | null; request: Prisma.JsonValue };
export function buildCaseStatusHint(
  status: CaseStatus,
  jobs: HintJob[],
  name: (key: string) => string,
  runnerOnline: boolean
): string {
  const req = (j: HintJob) => (j.request ?? {}) as { requiresApproval?: boolean; approved?: boolean };
  const list = (js: HintJob[]) => js.map((j) => name(j.systemKey)).join(", ");

  switch (status) {
    case "failed": {
      const failed = jobs.filter((j) => j.status === "failed");
      // The runner already prefixes its error with "[systemKey]"; strip it since we prefix the name.
      const clean = (e: string | null) => (e ?? "no detail").replace(/^\[[^\]]+\]\s*/, "");
      if (failed.length) return failed.map((j) => `${name(j.systemKey)} failed: ${clean(j.error)}`).join(" · ");
      return "a step failed";
    }
    case "needs_manual": {
      const manual = jobs.filter((j) => j.mode !== "api" && j.status === "manual");
      if (manual.length) return `Manual step${manual.length > 1 ? "s" : ""} — no API automation, a person must do: ${list(manual)}`;
      return "needs a manual step";
    }
    case "needs_approval": {
      const gated = jobs.filter((j) => req(j).requiresApproval && !req(j).approved && !STARTED_STATUSES.includes(j.status as never));
      return gated.length ? `Waiting for approval on: ${list(gated)} (destructive step)` : "waiting for approval on a destructive step";
    }
    case "running": {
      const active = jobs.filter((j) => j.status === "dispatched" || j.status === "running");
      return active.length ? `Running: ${list(active)}` : "running";
    }
    case "planning":
      return "being planned…";
    case "queued": {
      const pending = jobs.filter((j) => j.mode === "api" && j.status === "pending");
      if (!pending.length) return "queued";
      const next = pending.reduce((a, b) => (b.sequence < a.sequence ? b : a));
      // Predecessors (earlier api jobs) that haven't finished gate the next job — same rule as
      // dependencyGateOpen.
      const blockers = jobs.filter(
        (j) => j.mode === "api" && j.sequence < next.sequence && j.status !== "succeeded" && j.status !== "skipped"
      );
      if (blockers.length) return `Waiting on ${list(blockers)} to finish before ${name(next.systemKey)}`;
      return runnerOnline
        ? `Ready — waiting for a runner to claim ${name(next.systemKey)}`
        : `Ready, but no runner is online to claim it (next: ${name(next.systemKey)})`;
    }
    case "completed":
      return "all steps done";
    default:
      return "";
  }
}

export function makeCaseRepository(db: PrismaClient) {
  return {
    // Client + its systems + identity, needed to plan a case (identity/domain drive the UPN/
    // SamAccountName derivation). null if the client doesn't exist.
    async clientForPlanning(slug: string): Promise<
      | {
          id: string; name: string; slug: string; primaryDomain: string;
          emailDomain: string | null; emailDomainLocked: boolean; serviceNowSysId: string | null;
          identity: unknown; personas: unknown; globals: unknown; locations: unknown; systems: ClientSystem[];
        }
      | null
    > {
      const c = await db.client.findUnique({
        where: { slug },
        select: {
          id: true, name: true, slug: true, primaryDomain: true,
          emailDomain: true, emailDomainLocked: true, serviceNowSysId: true,
          identity: true, personas: true, globals: true, locations: true, systems: true,
        },
      });
      return c;
    },

    async clientSysIdToSlug(serviceNowSysId: string): Promise<string | null> {
      const c = await db.client.findUnique({ where: { serviceNowSysId }, select: { slug: true } });
      return c?.slug ?? null;
    },

    async findCaseIdByNumber(number: string): Promise<string | null> {
      const c = await db.caseRequest.findUnique({ where: { serviceNowCaseNumber: number }, select: { id: true } });
      return c?.id ?? null;
    },

    // Create the case + its planned jobs + set status, atomically.
    async createCaseWithJobs(
      input: NewCaseInput,
      clientId: string,
      planned: PlannedJob[],
      status: CaseStatus
    ): Promise<string> {
      const created = await db.$transaction(async (tx) => {
        const c = await tx.caseRequest.create({
          data: {
            clientId,
            action: input.action,
            serviceNowCaseNumber: input.serviceNowCaseNumber ?? null,
            subject: input.subject ?? null,
            status,
            dryRun: input.dryRun ?? false,
            payload: input.payload as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        if (planned.length > 0) {
          await tx.job.createMany({
            data: planned.map((p) => ({
              caseRequestId: c.id,
              systemKey: p.systemKey,
              sequence: p.sequence,
              mode: p.mode,
              status: p.mode === "api" ? "pending" : "manual",
              // Resolved instructions for the runner (Phase 3) + the planning flags we surface now.
              request: {
                config: p.config ?? null,
                requiresApproval: p.requiresApproval,
                captureEvidence: p.captureEvidence,
                secretNames: p.secretNames,
                dryRun: input.dryRun ?? false,
              } as Prisma.InputJsonValue,
            })),
          });
        }
        return c;
      });
      return created.id;
    },

    // Inputs for re-planning an existing case: its SN number + payload, the client (with current
    // identity + systems), and whether any job has already started (re-plan is pre-execution only).
    async replanInputs(caseId: string): Promise<
      | { serviceNowCaseNumber: string | null; action: Action; payload: Record<string, unknown>;
          client: {
            id: string; slug: string; primaryDomain: string;
            emailDomain: string | null; emailDomainLocked: boolean; serviceNowSysId: string | null;
            identity: unknown; personas: unknown; globals: unknown; locations: unknown; systems: ClientSystem[];
          }; started: boolean }
      | null
    > {
      const c = await db.caseRequest.findUnique({
        where: { id: caseId },
        select: {
          serviceNowCaseNumber: true, action: true, payload: true,
          client: {
            select: {
              id: true, slug: true, primaryDomain: true,
              emailDomain: true, emailDomainLocked: true, serviceNowSysId: true,
              identity: true, personas: true, globals: true, locations: true, systems: true,
            },
          },
          jobs: { select: { status: true } },
        },
      });
      if (!c) return null;
      return {
        serviceNowCaseNumber: c.serviceNowCaseNumber,
        action: c.action,
        payload: (c.payload ?? {}) as Record<string, unknown>,
        client: c.client,
        started: hasStartedJobs(c.jobs),
      };
    },

    // Re-plan: replace the case's jobs and refresh its action/payload/status in one transaction.
    async replanCaseJobs(
      caseId: string,
      upd: { action: Action; payload: Record<string, unknown>; status: CaseStatus },
      planned: PlannedJob[]
    ): Promise<void> {
      await db.$transaction(async (tx) => {
        // Race-safe guard (closes the TOCTOU window after replanInputs' pre-check): delete only
        // the not-yet-started jobs, then assert none remain. If a runner claimed a job between the
        // pre-check and here, a started job survives the delete → throw to roll the whole tx back
        // (no jobs lost), surfaced to the caller as `already_started`.
        await tx.job.deleteMany({ where: { caseRequestId: caseId, status: { notIn: STARTED_STATUSES } } });
        if ((await tx.job.count({ where: { caseRequestId: caseId } })) > 0) throw new CaseAlreadyStartedError();
        const existing = await tx.caseRequest.findUnique({ where: { id: caseId }, select: { dryRun: true } });
        const dryRun = existing?.dryRun ?? false; // replanned jobs inherit the case's current mode
        await tx.caseRequest.update({
          where: { id: caseId },
          data: { action: upd.action, payload: upd.payload as Prisma.InputJsonValue, status: upd.status },
        });
        if (planned.length > 0) {
          await tx.job.createMany({
            data: planned.map((p) => ({
              caseRequestId: caseId,
              systemKey: p.systemKey,
              sequence: p.sequence,
              mode: p.mode,
              status: p.mode === "api" ? "pending" : "manual",
              request: {
                config: p.config ?? null,
                requiresApproval: p.requiresApproval,
                captureEvidence: p.captureEvidence,
                secretNames: p.secretNames,
                dryRun,
              } as Prisma.InputJsonValue,
            })),
          });
        }
      });
    },

    // Toggle a case's dry-run mode and propagate it onto every not-yet-started job's request.dryRun
    // (atomic jsonb merge), so a runner that later claims one runs -WhatIf. Started jobs are left
    // alone. Returns the number of pending jobs updated.
    async setCaseDryRun(caseId: string, dryRun: boolean): Promise<number> {
      return db.$transaction(async (tx) => {
        await tx.caseRequest.update({ where: { id: caseId }, data: { dryRun } });
        const updated = await tx.$executeRaw`UPDATE "Job" SET "request" = COALESCE("request", '{}'::jsonb) || ${JSON.stringify({ dryRun })}::jsonb WHERE "caseRequestId" = ${caseId} AND "status" NOT IN ('dispatched', 'running', 'succeeded', 'failed', 'skipped')`;
        return updated;
      });
    },

    async listCases(): Promise<CaseListItem[]> {
      const rows = await db.caseRequest.findMany({
        where: { deletedAt: null }, // trashed cases live in the Trash section, not the main list
        orderBy: { createdAt: "desc" },
        select: {
          id: true, action: true, status: true, subject: true,
          serviceNowCaseNumber: true, createdAt: true, clientId: true,
          client: { select: { name: true, slug: true } },
          jobs: { select: { systemKey: true, sequence: true, status: true, mode: true, error: true, request: true } },
        },
      });

      // Resolve display names for every system in play (one query) + which clients have a runner
      // online right now (so a "queued" hint can say "no runner online" — the usual stall cause).
      const keys = [...new Set(rows.flatMap((r) => r.jobs.map((j) => j.systemKey)))];
      const catalog = keys.length
        ? await db.systemCatalog.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } })
        : [];
      const nameByKey = new Map(catalog.map((s) => [s.key, s.name]));
      const onlineCutoff = new Date(Date.now() - 90_000);
      const onlineAgents = await db.agent.findMany({
        where: { enabled: true, deletedAt: null, lastSeenAt: { gt: onlineCutoff } },
        select: { clientId: true },
      });
      // A case is servable if a central runner (clientId null) OR a runner bound to its client is up.
      const centralOnline = onlineAgents.some((a) => a.clientId === null);
      const clientHasRunner = new Set(onlineAgents.map((a) => a.clientId).filter(Boolean) as string[]);

      return rows.map((r) => ({
        id: r.id, action: r.action, status: r.status, subject: r.subject,
        serviceNowCaseNumber: r.serviceNowCaseNumber, createdAt: r.createdAt,
        clientName: r.client.name, clientSlug: r.client.slug, jobCount: r.jobs.length,
        statusHint: buildCaseStatusHint(
          r.status,
          r.jobs,
          (k) => nameByKey.get(k) ?? k,
          centralOnline || clientHasRunner.has(r.clientId)
        ),
      }));
    },

    // Cases in the trash (soft-deleted) — for the collapsible Trash section. Newest-trashed first.
    async listTrashedCases(): Promise<TrashedCaseItem[]> {
      const rows = await db.caseRequest.findMany({
        where: { deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        select: {
          id: true, action: true, status: true, subject: true, serviceNowCaseNumber: true,
          deletedAt: true, client: { select: { name: true } }, _count: { select: { jobs: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id, action: r.action, status: r.status, subject: r.subject,
        serviceNowCaseNumber: r.serviceNowCaseNumber, deletedAt: r.deletedAt as Date,
        clientName: r.client.name, jobCount: r._count.jobs,
      }));
    },

    // Move a case to the trash (soft delete) — removed from the list, restorable for 30 days. Jobs
    // are kept (so a restore brings back the run history). Refuses while a job is genuinely in
    // flight so we don't orphan a runner mid-execution. Idempotent if already trashed.
    async trashCase(id: string): Promise<
      | { ok: true; subject: string | null; clientId: string }
      | { ok: false; reason: "not_found" | "in_flight" }
    > {
      const c = await db.caseRequest.findUnique({
        where: { id },
        select: { id: true, subject: true, clientId: true, deletedAt: true, jobs: { select: { status: true } } },
      });
      if (!c) return { ok: false, reason: "not_found" };
      if (c.jobs.some((j) => j.status === "dispatched" || j.status === "running")) return { ok: false, reason: "in_flight" };
      if (!c.deletedAt) await db.caseRequest.update({ where: { id }, data: { deletedAt: new Date() } });
      return { ok: true, subject: c.subject, clientId: c.clientId };
    },

    // Restore a trashed case back to the list. Also used by re-import (re-importing a trashed
    // number brings it back rather than colliding on the unique SN number).
    async restoreCase(id: string): Promise<{ ok: true; clientId: string } | { ok: false; reason: "not_found" }> {
      const c = await db.caseRequest.findUnique({ where: { id }, select: { id: true, clientId: true } });
      if (!c) return { ok: false, reason: "not_found" };
      await db.caseRequest.update({ where: { id }, data: { deletedAt: null } });
      return { ok: true, clientId: c.clientId };
    },

    // Permanently delete a case and its jobs (Job.case isn't onDelete:Cascade, so remove jobs first
    // in a transaction). AuditLog rows are an unconstrained log — left intact as history.
    async deleteCaseForever(id: string): Promise<{ ok: true; subject: string | null; clientId: string } | { ok: false; reason: "not_found" }> {
      const c = await db.caseRequest.findUnique({ where: { id }, select: { id: true, subject: true, clientId: true } });
      if (!c) return { ok: false, reason: "not_found" };
      await db.$transaction([
        db.job.deleteMany({ where: { caseRequestId: id } }),
        db.caseRequest.delete({ where: { id } }),
      ]);
      return { ok: true, subject: c.subject, clientId: c.clientId };
    },

    // Hard-delete every case that has sat in the trash past the retention window (called on the
    // cases page load, mirroring the agents purge). Returns the count purged.
    async purgeExpiredTrashedCases(cutoff: Date): Promise<number> {
      const expired = await db.caseRequest.findMany({
        where: { deletedAt: { not: null, lte: cutoff } },
        select: { id: true },
      });
      if (expired.length === 0) return 0;
      const ids = expired.map((e) => e.id);
      await db.$transaction([
        db.job.deleteMany({ where: { caseRequestId: { in: ids } } }),
        db.caseRequest.deleteMany({ where: { id: { in: ids } } }),
      ]);
      return ids.length;
    },

    async getCase(id: string): Promise<CaseDetail | null> {
      const c = await db.caseRequest.findUnique({
        where: { id },
        include: {
          client: { select: { name: true, slug: true } },
          jobs: { orderBy: { sequence: "asc" } },
        },
      });
      if (!c) return null;

      // Job stores only systemKey; resolve display names from the catalog in one query.
      const keys = [...new Set(c.jobs.map((j) => j.systemKey))];
      const catalog = await db.systemCatalog.findMany({
        where: { key: { in: keys } },
        select: { key: true, name: true },
      });
      const nameByKey = new Map(catalog.map((s) => [s.key, s.name]));

      return {
        id: c.id, action: c.action, status: c.status, subject: c.subject, dryRun: c.dryRun,
        serviceNowCaseNumber: c.serviceNowCaseNumber, createdAt: c.createdAt,
        client: c.client,
        payload: (c.payload ?? {}) as Record<string, unknown>,
        jobs: c.jobs.map((j) => {
          const req = (j.request ?? {}) as { requiresApproval?: boolean };
          return {
            id: j.id,
            systemKey: j.systemKey,
            systemName: nameByKey.get(j.systemKey) ?? j.systemKey,
            sequence: j.sequence,
            mode: j.mode,
            status: j.status,
            requiresApproval: Boolean(req.requiresApproval),
            isManual: j.mode !== "api",
          };
        }),
      };
    },

    async writeAudit(entry: AuditEntry): Promise<void> {
      await db.auditLog.create({
        data: {
          actor: entry.actor,
          action: entry.action,
          clientId: entry.clientId ?? null,
          caseRequestId: entry.caseRequestId ?? null,
          detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    },
  };
}

export type CaseRepository = ReturnType<typeof makeCaseRepository>;
