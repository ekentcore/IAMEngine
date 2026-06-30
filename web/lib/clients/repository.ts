// Thin Prisma wrapper for the clients domain. No business logic — callers pass resolved
// values. Built as a factory so tests can inject a mock/throwaway PrismaClient.
import type { PrismaClient, Prisma, Backbone } from "@prisma/client";
import type { NormalizedSnClient } from "../servicenow/mappers";
import { type ClientScope, clientIdWhere, scopeAllows } from "../auth/client-scope";
import type { AuditEntry, ClientDetail, ClientListItem, CreateClientInput, EditableSystem } from "./types";
import { computeClientReadiness, type ConnTestState, type ClientReadiness } from "./readiness";

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

// Add a field to a client's editedFields (deduped), returning the new array to set in an update.
async function addEdited(db: PrismaClient, slug: string, field: string): Promise<string[]> {
  const c = await db.client.findUnique({ where: { slug }, select: { editedFields: true } });
  return Array.from(new Set([...(c?.editedFields ?? []), field]));
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
    // `scope` (default unrestricted) limits the list to the operator's visible clients — see
    // lib/auth/client-scope. Callers in a request context pass currentClientScope(db).
    async listClients(scope: ClientScope = null): Promise<ClientListItem[]> {
      const rows = await db.client.findMany({
        where: { id: clientIdWhere(scope) },
        orderBy: { name: "asc" },
        select: {
          id: true,
          slug: true,
          name: true,
          primaryDomain: true,
          backbone: true,
          status: true,
          intakeSource: true,
          restricted: true,
          coreId: true,
          region: true,
          supportStatus: true,
          onboardingRating: true,
          offboardingRating: true,
          snLastSyncedAt: true,
          editedFields: true,
          identity: true,
          emailDomain: true,
          systems: { select: { systemKey: true, mode: true, onboardWhen: true, offboardWhen: true, secretNames: true } },
          // the runbook seq is the documented run order; used to list systems in execution order
          runbook: { select: { systemKey: true, action: true, seq: true } },
          // parent (SN account hierarchy): a child with no OWN systems inherits the parent's at plan
          // time. Surface whether the parent is modeled so the UI can distinguish "via parent" from
          // "completely unmodeled".
          parentId: true,
          parent: { select: { name: true, systems: { select: { systemKey: true } } } },
        },
      });
      // Readiness inputs, batched across all listed clients (no per-row queries): the client's wired
      // secret references + the latest connection-test outcome per system.
      const ids = rows.map((r) => r.id);
      const [secretRows, testRows] = ids.length
        ? await Promise.all([
            db.secret.findMany({ where: { clientId: { in: ids } }, select: { clientId: true, name: true, externalId: true } }),
            db.connectionTest.findMany({
              where: { clientId: { in: ids } },
              select: { clientId: true, systemKey: true, status: true, finishedAt: true },
              orderBy: { finishedAt: "desc" }, // newest first -> first seen per (client, system) is latest
            }),
          ])
        : [[], []];
      const secretsByClient = new Map<string, Map<string, string | null>>();
      for (const s of secretRows) {
        const m = secretsByClient.get(s.clientId) ?? new Map<string, string | null>();
        m.set(s.name, s.externalId); secretsByClient.set(s.clientId, m);
      }
      const testsByClient = new Map<string, Map<string, ConnTestState>>();
      for (const t of testRows) {
        const m = testsByClient.get(t.clientId) ?? new Map<string, ConnTestState>();
        if (!m.has(t.systemKey)) m.set(t.systemKey, t.status === "ok" ? "ok" : t.status === "fail" ? "fail" : "untested");
        testsByClient.set(t.clientId, m);
      }

      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        primaryDomain: r.primaryDomain,
        backbone: r.backbone,
        status: r.status,
        intakeSource: r.intakeSource,
        restricted: r.restricted,
        coreId: r.coreId,
        region: r.region,
        supportStatus: r.supportStatus,
        onboardingRating: r.onboardingRating,
        offboardingRating: r.offboardingRating,
        snLastSyncedAt: r.snLastSyncedAt,
        editedFields: r.editedFields,
        emailDomain: r.emailDomain,
        // primary + any conflict fallbacks, as "{first}.{last} | {first}.{mi}" (local parts).
        usernamePattern: (((r.identity as { usernamePatterns?: string[] } | null)?.usernamePatterns ?? []).length
          ? (r.identity as { usernamePatterns: string[] }).usernamePatterns
          : ["{first}.{last}@{domain}"]).map((p) => p.split("@")[0]).join(" | "),
        systemKeys: orderByRunSequence(r.systems.map((s) => s.systemKey), r.runbook),
        systemCount: r.systems.length,
        modeled: r.systems.length > 0,
        parentId: r.parentId,
        parentName: r.parent?.name ?? null,
        parentSystemKeys: r.parent?.systems.map((s) => s.systemKey) ?? [],
        // own = has its own systems; parent = inherits a modeled parent; none = truly unmodeled.
        coverage: r.systems.length > 0 ? "own" : r.parentId && (r.parent?.systems.length ?? 0) > 0 ? "parent" : "none",
        // Run-readiness, computed from wired secrets + latest connection tests (own systems).
        readiness: computeClientReadiness({
          systems: r.systems
            .filter((s) => s.mode === "api" && s.secretNames.length > 0 && (s.onboardWhen !== "never" || s.offboardWhen !== "never"))
            .map((s) => ({ systemKey: s.systemKey, secretNames: s.secretNames })),
          secretExternalIds: secretsByClient.get(r.id) ?? new Map(),
          testBySystem: testsByClient.get(r.id) ?? new Map(),
        }),
      }));
    },

    // Run-readiness for a single client (the detail-page panel): same computation as the list, with
    // the per-system breakdown. Computed from the client's wired secrets + latest connection tests.
    async clientReadiness(slug: string): Promise<ClientReadiness | null> {
      const c = await db.client.findUnique({
        where: { slug },
        select: {
          id: true,
          systems: { select: { systemKey: true, mode: true, onboardWhen: true, offboardWhen: true, secretNames: true } },
          secrets: { select: { name: true, externalId: true } },
        },
      });
      if (!c) return null;
      const tests = await db.connectionTest.findMany({
        where: { clientId: c.id }, select: { systemKey: true, status: true, finishedAt: true }, orderBy: { finishedAt: "desc" },
      });
      const testBySystem = new Map<string, ConnTestState>();
      for (const t of tests) if (!testBySystem.has(t.systemKey)) testBySystem.set(t.systemKey, t.status === "ok" ? "ok" : t.status === "fail" ? "fail" : "untested");
      return computeClientReadiness({
        systems: c.systems
          .filter((s) => s.mode === "api" && s.secretNames.length > 0 && (s.onboardWhen !== "never" || s.offboardWhen !== "never"))
          .map((s) => ({ systemKey: s.systemKey, secretNames: s.secretNames })),
        secretExternalIds: new Map(c.secrets.map((s) => [s.name, s.externalId])),
        testBySystem,
      });
    },

    // `scope` (default unrestricted) hard-gates direct access: an out-of-scope client reads as
    // not-found (404) so a hidden client can't be loaded by guessing its slug.
    async getClientBySlug(slug: string, scope: ClientScope = null): Promise<ClientDetail | null> {
      const client = (await db.client.findUnique({
        where: { slug },
        include: {
          systems: {
            orderBy: { systemKey: "asc" },
            include: { system: { select: { name: true, buildTier: true, moduleName: true } } },
          },
          secrets: { select: { name: true, provider: true, label: true } },
        },
      })) as unknown as (ClientDetail & { id: string }) | null;
      if (client && !scopeAllows(scope, client.id)) return null;
      return client;
    },

    // Lightweight index for reconciliation: who already exists and how they're keyed.
    async indexExisting(): Promise<
      Array<{ id: string; slug: string; primaryDomain: string; serviceNowSysId: string | null; editedFields: string[] }>
    > {
      return db.client.findMany({
        select: { id: true, slug: true, primaryDomain: true, serviceNowSysId: true, editedFields: true },
      });
    },

    // Routine sync: refresh SN-owned fields (incl. the website-derived primaryDomain) EXCEPT any a
    // human edited in the UI (editedFields) — those stay until a hard refresh clears them.
    async refreshSnFields(clientId: string, c: NormalizedSnClient, editedFields: string[] = []): Promise<void> {
      const data: Record<string, unknown> = { ...snData(c), serviceNowSysId: c.serviceNowSysId, primaryDomain: c.primaryDomain };
      for (const f of editedFields) delete data[f];
      await db.client.update({ where: { id: clientId }, data });
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

    // Second sync pass: link children to parents by SN sys_id (the parent row may not have existed
    // during the main loop). Only SETS links — never clears one — so an SN hiccup that drops the
    // parent field for a sync can't sever an established inheritance.
    async linkParentsBySysId(links: Array<{ childSysId: string; parentSysId: string }>): Promise<number> {
      if (links.length === 0) return 0;
      const sysIds = [...new Set(links.flatMap((l) => [l.childSysId, l.parentSysId]))];
      const rows = await db.client.findMany({
        where: { serviceNowSysId: { in: sysIds } },
        select: { id: true, serviceNowSysId: true, parentId: true },
      });
      const bySys = new Map(rows.map((r) => [r.serviceNowSysId!, r]));
      let linked = 0;
      for (const l of links) {
        const child = bySys.get(l.childSysId);
        const parent = bySys.get(l.parentSysId);
        if (!child || !parent || child.id === parent.id || child.parentId === parent.id) continue;
        await db.client.update({ where: { id: child.id }, data: { parentId: parent.id } });
        linked++;
      }
      return linked;
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

    // Inline table edits — also record the field as hand-edited so routine sync won't clobber it.
    async setPrimaryDomain(slug: string, primaryDomain: string) {
      return db.client.update({ where: { slug }, data: { primaryDomain, editedFields: await addEdited(db, slug, "primaryDomain") } });
    },
    async setBackbone(slug: string, backbone: Backbone | null) {
      return db.client.update({ where: { slug }, data: { backbone, editedFields: await addEdited(db, slug, "backbone") } });
    },
    // Mark where this client's onboarding/offboarding requests come from: "um" (external) or
    // "incident" (internal). Drives which ServiceNow table case-scanning reads.
    async setIntakeSource(slug: string, intakeSource: "um" | "incident") {
      return db.client.update({ where: { slug }, data: { intakeSource } });
    },
    // Internal-only flag: a restricted client is hidden from operators not granted it (see
    // lib/auth/client-scope). Access-control decision — callers gate on user.manage.
    async setRestricted(slug: string, restricted: boolean) {
      return db.client.update({ where: { slug }, data: { restricted } });
    },
    // The email/UPN name format (identity.usernamePatterns[0]). `localPattern` is the part before
    // @; we store it as `<local>@{domain}` to match the existing convention (deriveIdentity uses
    // the left-of-@ part and resolves the domain separately).
    async setUsernamePattern(slug: string, localPattern: string, fallbacks: string[] = []) {
      const c = await db.client.findUnique({ where: { slug }, select: { identity: true } });
      const identity = (c?.identity ?? {}) as Record<string, unknown>;
      // [0] = primary username; [1..] = conflict fallbacks (used when the primary UPN is taken).
      const patterns = [`${localPattern}@{domain}`, ...fallbacks.filter(Boolean).map((f) => `${f}@{domain}`)];
      const next = { ...identity, usernamePatterns: patterns };
      return db.client.update({
        where: { slug },
        data: { identity: next as Prisma.InputJsonValue, editedFields: await addEdited(db, slug, "usernamePattern") },
      });
    },

    // Read the v2.1 rules (personas/globals/locations) for the editor. Separate from getClientBySlug
    // (which omits them) so the editor loads exactly what it round-trips back via setRules.
    async getRules(slug: string): Promise<{ id: string; personas: unknown; globals: unknown; globalsOffboard: unknown; locations: unknown; systemKeys: string[]; adObjects: unknown; cloudGroups: unknown } | null> {
      const c = await db.client.findUnique({
        where: { slug },
        select: { id: true, personas: true, globals: true, globalsOffboard: true, locations: true, adObjects: true, cloudGroups: true, systems: { select: { systemKey: true }, orderBy: { systemKey: "asc" } } },
      });
      if (!c) return null;
      return { id: c.id, personas: c.personas, globals: c.globals, globalsOffboard: c.globalsOffboard, locations: c.locations, systemKeys: c.systems.map((s) => s.systemKey), adObjects: c.adObjects, cloudGroups: c.cloudGroups };
    },

    // Replace the personas + globals (onboard) + globalsOffboard JSON columns wholesale (the editor
    // sends the full objects, so a partial save can't drop sibling rules). locations untouched.
    async setRules(slug: string, personas: unknown, globals: unknown, globalsOffboard: unknown) {
      return db.client.update({
        where: { slug },
        data: {
          personas: personas as Prisma.InputJsonValue,
          globals: globals as Prisma.InputJsonValue,
          globalsOffboard: globalsOffboard as Prisma.InputJsonValue,
        },
      });
    },

    // Hard refresh: overwrite ALL SN-owned fields from a freshly-fetched account (incl. the
    // website domain) and clear the edited markers. The caller supplies the normalized account.
    async overwriteFromSn(clientId: string, c: NormalizedSnClient): Promise<void> {
      await db.client.update({
        where: { id: clientId },
        data: { ...snData(c), serviceNowSysId: c.serviceNowSysId, primaryDomain: c.primaryDomain, editedFields: [] },
      });
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
          parentId: true,
          systems: { select: { systemKey: true, secretNames: true } },
          secrets: { select: { name: true, externalId: true, label: true, provider: true } },
        },
      });
      if (!c) return null;
      // A system-less child plans with its PARENT's runbook (clientForPlanning), so its cases
      // broker the parent's secret NAMES against THIS client's Secret rows. Mirror that fallback
      // here so the child's Secrets panel lists exactly the names its cases will need — otherwise
      // the panel is empty and the operator has no way to wire the child's credentials at all.
      let systems = c.systems;
      if (systems.length === 0 && c.parentId) {
        const p = await db.client.findUnique({
          where: { id: c.parentId },
          select: { systems: { select: { systemKey: true, secretNames: true } } },
        });
        if (p && p.systems.length > 0) systems = p.systems;
      }
      return { clientId: c.id, systems, secrets: c.secrets };
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
