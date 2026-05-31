// Thin Prisma wrapper for the clients domain. No business logic — callers pass resolved
// values. Built as a factory so tests can inject a mock/throwaway PrismaClient.
import type { PrismaClient, Prisma } from "@prisma/client";
import type { NormalizedSnClient } from "../servicenow/mappers";
import type { AuditEntry, ClientDetail, ClientListItem, CreateClientInput } from "./types";

// SN-owned fields written on both create and update (never touches backbone or systems).
// Return type is inferred (plain scalars) so it spreads into both create and update inputs.
function snData(c: NormalizedSnClient) {
  return {
    name: c.name,
    coreId: c.coreId,
    region: c.region,
    timezone: c.timezone,
    supportStatus: c.supportStatus,
    coManaged: c.coManaged,
    onboardingRating: c.onboardingRating,
    offboardingRating: c.offboardingRating,
    metadata: c.metadata as Prisma.InputJsonValue,
    snLastSyncedAt: new Date(),
  };
}

export function makeClientRepository(db: PrismaClient) {
  return {
    async listClients(): Promise<ClientListItem[]> {
      const rows = await db.client.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          slug: true,
          name: true,
          primaryDomain: true,
          backbone: true,
          status: true,
          coreId: true,
          region: true,
          supportStatus: true,
          onboardingRating: true,
          offboardingRating: true,
          snLastSyncedAt: true,
          _count: { select: { systems: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        primaryDomain: r.primaryDomain,
        backbone: r.backbone,
        status: r.status,
        coreId: r.coreId,
        region: r.region,
        supportStatus: r.supportStatus,
        onboardingRating: r.onboardingRating,
        offboardingRating: r.offboardingRating,
        snLastSyncedAt: r.snLastSyncedAt,
        systemCount: r._count.systems,
        modeled: r._count.systems > 0,
      }));
    },

    async getClientBySlug(slug: string): Promise<ClientDetail | null> {
      return db.client.findUnique({
        where: { slug },
        include: {
          systems: {
            orderBy: { systemKey: "asc" },
            include: { system: { select: { name: true, buildTier: true, moduleName: true } } },
          },
          secrets: { select: { name: true, provider: true, label: true } },
        },
      }) as unknown as Promise<ClientDetail | null>;
    },

    // Lightweight index for reconciliation: who already exists and how they're keyed.
    async indexExisting(): Promise<
      Array<{ id: string; slug: string; primaryDomain: string; serviceNowSysId: string | null }>
    > {
      return db.client.findMany({
        select: { id: true, slug: true, primaryDomain: true, serviceNowSysId: true },
      });
    },

    async refreshSnFields(clientId: string, c: NormalizedSnClient): Promise<void> {
      await db.client.update({
        where: { id: clientId },
        data: { ...snData(c), serviceNowSysId: c.serviceNowSysId },
      });
    },

    // Idempotent: keyed on serviceNowSysId so re-runs and concurrent syncs converge
    // instead of throwing unique-constraint errors (CLAUDE.md: executors are idempotent).
    async createFromSn(c: NormalizedSnClient, slug: string): Promise<string> {
      const row = await db.client.upsert({
        where: { serviceNowSysId: c.serviceNowSysId },
        update: { ...snData(c) },
        create: {
          slug,
          primaryDomain: c.primaryDomain,
          domains: c.primaryDomain ? [c.primaryDomain] : [],
          backbone: null, // roster-only until a profile is applied
          serviceNowSysId: c.serviceNowSysId,
          ...snData(c), // includes name + all SN fields
        },
        select: { id: true },
      });
      return row.id;
    },

    async slugExists(slug: string): Promise<boolean> {
      return (await db.client.count({ where: { slug } })) > 0;
    },

    async createClient(input: CreateClientInput, slug: string) {
      return db.client.create({
        data: {
          slug,
          name: input.name,
          primaryDomain: input.primaryDomain,
          domains: input.primaryDomain ? [input.primaryDomain] : [],
          backbone: input.backbone ?? null,
          coreId: input.coreId ?? null,
          pod: input.pod ?? null,
        },
      });
    },

    async setStatus(slug: string, status: "active" | "archived") {
      return db.client.update({
        where: { slug },
        data: { status, archivedAt: status === "archived" ? new Date() : null },
      });
    },

    async writeAudit(entry: AuditEntry): Promise<void> {
      await db.auditLog.create({
        data: {
          actor: entry.actor,
          action: entry.action,
          clientId: entry.clientId ?? null,
          detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    },
  };
}

export type ClientRepository = ReturnType<typeof makeClientRepository>;
