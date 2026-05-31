// Thin Prisma wrapper for the cases domain. Factory-style for testability, mirroring
// lib/clients/repository.ts.
import type { PrismaClient, Prisma, ClientSystem, CaseStatus } from "@prisma/client";
import type { PlannedJob } from "../orchestrator";
import type { AuditEntry } from "../clients/types";
import type { CaseDetail, CaseListItem, NewCaseInput } from "./types";

export function makeCaseRepository(db: PrismaClient) {
  return {
    // Client + its systems, needed to plan a case. null if the client doesn't exist.
    async clientForPlanning(slug: string): Promise<{ id: string; name: string; slug: string; systems: ClientSystem[] } | null> {
      const c = await db.client.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true, systems: true },
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
              } as Prisma.InputJsonValue,
            })),
          });
        }
        return c;
      });
      return created.id;
    },

    async listCases(): Promise<CaseListItem[]> {
      const rows = await db.caseRequest.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true, action: true, status: true, subject: true,
          serviceNowCaseNumber: true, createdAt: true,
          client: { select: { name: true, slug: true } },
          _count: { select: { jobs: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id, action: r.action, status: r.status, subject: r.subject,
        serviceNowCaseNumber: r.serviceNowCaseNumber, createdAt: r.createdAt,
        clientName: r.client.name, clientSlug: r.client.slug, jobCount: r._count.jobs,
      }));
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
        id: c.id, action: c.action, status: c.status, subject: c.subject,
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
