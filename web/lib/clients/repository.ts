// Thin Prisma wrapper for the clients domain. No business logic — callers pass resolved
// values. Built as a factory so tests can inject a mock/throwaway PrismaClient.
import type { PrismaClient, Prisma, Backbone } from "@prisma/client";
import type { NormalizedSnClient } from "../servicenow/mappers";
import type { AuditEntry, ClientDetail, ClientListItem, CreateClientInput, EditableSystem } from "./types";

// Order systemKeys by the runbook's documented run sequence (onboard first — the primary process,
// and where "resolving case" lands last — then offboard-only systems by their seq; any system with
// no runbook section sorts last, alphabetically). This is the order the engineer runs the process,
// not alphabetical.
function orderByRunSequence(
  systemKeys: string[],
  sections: { systemKey: string | null; action: string; seq: number }[]
): string[] {
  const rank = new Map<string, number>();
  for (const s of sections) {
    if (!s.systemKey) continue;
    const r = s.action === "onboard" ? s.seq : 1000 + s.seq; // onboard ranks before offboard-only
    const cur = rank.get(s.systemKey);
    if (cur === undefined || r < cur) rank.set(s.systemKey, r);
  }
  const FALLBACK = Number.MAX_SAFE_INTEGER;
  return [...systemKeys].sort((a, b) => {
    const ra = rank.get(a) ?? FALLBACK;
    const rb = rank.get(b) ?? FALLBACK;
    return ra - rb || a.localeCompare(b);
  });
}

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
          systems: { select: { systemKey: true } },
          // the runbook seq is the documented run order; used to list systems in execution order
          runbook: { select: { systemKey: true, action: true, seq: true } },
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
        systemKeys: orderByRunSequence(r.systems.map((s) => s.systemKey), r.runbook),
        systemCount: r.systems.length,
        modeled: r.systems.length > 0,
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

    // Inline table edits.
    async setPrimaryDomain(slug: string, primaryDomain: string) {
      return db.client.update({ where: { slug }, data: { primaryDomain } });
    },
    async setBackbone(slug: string, backbone: Backbone | null) {
      return db.client.update({ where: { slug }, data: { backbone } });
    },

    // Cache a contact-derived email domain (best-effort, from the domain resolver). Never touches a
    // locked value — the resolver only calls this on the unlocked path.
    async setEmailDomain(clientId: string, emailDomain: string): Promise<void> {
      await db.client.update({ where: { id: clientId }, data: { emailDomain } });
    },

    // Human curation: set (or clear) the email domain and its lock. A locked value is authoritative
    // — the contact-derivation won't overwrite it.
    async setCuratedEmailDomain(slug: string, emailDomain: string | null, lock: boolean) {
      return db.client.update({
        where: { slug },
        data: { emailDomain, emailDomainLocked: lock },
      });
    },

    // Replace a client's whole system set (and optionally its backbone) in one transaction:
    // upsert each desired system, delete any the client has that aren't in the new set.
    async replaceSystems(
      slug: string,
      systems: EditableSystem[],
      backbone?: Backbone | null
    ): Promise<{ clientId: string; upserted: number; removed: number } | null> {
      const client = await db.client.findUnique({ where: { slug }, select: { id: true } });
      if (!client) return null;
      const keep = new Set(systems.map((s) => s.systemKey));

      const removed = await db.$transaction(async (tx) => {
        if (backbone !== undefined) {
          await tx.client.update({ where: { id: client.id }, data: { backbone } });
        }
        for (const s of systems) {
          const data = {
            mode: s.mode,
            onboardWhen: s.onboardWhen,
            offboardWhen: s.offboardWhen,
            dependsOn: s.dependsOn ?? [],
            requiresApproval: s.requiresApproval,
            captureEvidence: s.captureEvidence,
            secretNames: s.secretNames ?? [],
            config: (s.config ?? undefined) as Prisma.InputJsonValue | undefined,
          };
          await tx.clientSystem.upsert({
            where: { clientId_systemKey: { clientId: client.id, systemKey: s.systemKey } },
            update: data,
            create: { clientId: client.id, systemKey: s.systemKey, ...data },
          });
        }
        const del = await tx.clientSystem.deleteMany({
          where: { clientId: client.id, systemKey: { notIn: [...keep] } },
        });
        return del.count;
      });

      return { clientId: client.id, upserted: systems.length, removed };
    },

    // Secret wiring for the per-client secrets panel: the systems' secretName references + the
    // saved Delinea references (id included — unlike getClientBySlug, which omits it). null if the
    // client doesn't exist.
    async secretsWiring(slug: string): Promise<
      | {
          clientId: string;
          systems: { systemKey: string; secretNames: string[] }[];
          secrets: { name: string; externalId: string; label: string | null; provider: string }[];
        }
      | null
    > {
      const c = await db.client.findUnique({
        where: { slug },
        select: {
          id: true,
          systems: { select: { systemKey: true, secretNames: true } },
          secrets: { select: { name: true, externalId: true, label: true, provider: true } },
        },
      });
      if (!c) return null;
      return { clientId: c.id, systems: c.systems, secrets: c.secrets };
    },

    // Upsert the client's Delinea references (name -> id + label). Stores only references.
    async upsertSecrets(clientId: string, entries: { name: string; externalId: string; label?: string | null }[]): Promise<void> {
      await db.$transaction(
        entries.map((e) =>
          db.secret.upsert({
            where: { clientId_name: { clientId, name: e.name } },
            update: { externalId: e.externalId, label: e.label ?? null },
            create: { clientId, name: e.name, provider: "delinea", externalId: e.externalId, label: e.label ?? null },
          })
        )
      );
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
