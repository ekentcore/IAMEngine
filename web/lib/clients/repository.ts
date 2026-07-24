// Thin Prisma wrapper for the clients domain. No business logic — callers pass resolved
// values. Built as a factory so tests can inject a mock/throwaway PrismaClient.
import type { PrismaClient, Backbone } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { NormalizedSnClient } from "../servicenow/mappers";
import { parseIntakeRules, type IntakeRulesDoc } from "../profiles/intake-rules";
import { normalizeCoreId } from "./core-id";
import { type ClientScope, clientIdWhere, scopeAllows } from "../auth/client-scope";
import { resolveActor, type ActorInput } from "../auth/actor";
import type { AuditEntry, ClientDetail, ClientListItem, CreateClientInput, EditableSystem } from "./types";
import { computeClientReadiness, type ConnTestState, type ClientReadiness, type RightsState } from "./readiness";
import { parseRights, summarizeRights } from "../jobs/conn-test-logic";

// Roll a stored ConnectionTest.rights JSON up to the RightsState the readiness vector consumes.
function rightsStateOf(raw: unknown): RightsState {
  const s = summarizeRights(parseRights(raw));
  return s.state === "verified" ? "verified" : s.state === "missing" ? "missing" : s.state === "unverified" ? "unverified" : "unknown";
}

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
    // Canonical shape ("CORE1269"). coreId is a case-SENSITIVE unique column, so storing ServiceNow's
    // raw value alongside a normalized one elsewhere would let two rows exist for one company — and a
    // case-insensitive lookup would then pick between them at random.
    coreId: c.coreId ? normalizeCoreId(c.coreId) ?? c.coreId : null,
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

// The secret references a client's jobs can actually broker: its own, plus the PARENT's for any
// name it hasn't wired itself (the child's own always wins). Mirrors the dispatch-time fallback in
// runner-service / case-secrets-repo, so readiness can't call a child "not set up" over credentials
// the runner would have resolved from the parent.
function brokerableSecrets(
  byClient: Map<string, Map<string, string | null>>,
  clientId: string,
  parentId: string | null
): Map<string, string | null> {
  const own = byClient.get(clientId) ?? new Map<string, string | null>();
  const fromParent = parentId ? byClient.get(parentId) : undefined;
  if (!fromParent || fromParent.size === 0) return own;
  return new Map([...fromParent, ...own]); // own entries overwrite the parent's
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
          engineOptOut: true,
          inheritParentSystems: true,
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
      // A child's jobs broker the PARENT's secrets for any name it hasn't wired itself (see
      // runner-service / case-secrets-repo). Pull the parents' secrets too — including parents that
      // aren't in the listed rows (out of scope) — so readiness reflects what dispatch will actually
      // resolve, instead of flagging a working child as "not set up".
      const parentIds = [...new Set(rows.map((r) => r.parentId).filter((id): id is string => Boolean(id)))];
      const secretIds = [...new Set([...ids, ...parentIds])];
      const [secretRows, testRows, setupRows] = ids.length
        ? await Promise.all([
            db.secret.findMany({ where: { clientId: { in: secretIds } }, select: { clientId: true, name: true, externalId: true } }),
            db.connectionTest.findMany({
              where: { clientId: { in: ids } },
              select: { clientId: true, systemKey: true, status: true, fieldsOk: true, rights: true, finishedAt: true },
              orderBy: { finishedAt: "desc" }, // newest first -> first seen per (client, system) is latest
            }),
            db.systemSetupState.findMany({ where: { clientId: { in: ids } }, select: { clientId: true, systemKey: true, startedAt: true, attestedAt: true } }),
          ])
        : [[], [], []];
      const secretsByClient = new Map<string, Map<string, string | null>>();
      for (const s of secretRows) {
        const m = secretsByClient.get(s.clientId) ?? new Map<string, string | null>();
        m.set(s.name, s.externalId); secretsByClient.set(s.clientId, m);
      }
      const testsByClient = new Map<string, Map<string, ConnTestState>>();
      const preflightByClient = new Map<string, Map<string, boolean | null>>();
      const rightsByClient = new Map<string, Map<string, RightsState>>();
      for (const t of testRows) {
        const m = testsByClient.get(t.clientId) ?? new Map<string, ConnTestState>();
        if (!m.has(t.systemKey)) {
          m.set(t.systemKey, t.status === "ok" ? "ok" : t.status === "fail" ? "fail" : "untested");
          const pf = preflightByClient.get(t.clientId) ?? new Map<string, boolean | null>();
          pf.set(t.systemKey, t.fieldsOk); preflightByClient.set(t.clientId, pf);
          const rs = rightsByClient.get(t.clientId) ?? new Map<string, RightsState>();
          rs.set(t.systemKey, rightsStateOf(t.rights)); rightsByClient.set(t.clientId, rs);
        }
        testsByClient.set(t.clientId, m);
      }
      const setupByClient = new Map<string, Map<string, { startedAt: Date | null; attestedAt: Date | null }>>();
      for (const s of setupRows) {
        const m = setupByClient.get(s.clientId) ?? new Map<string, { startedAt: Date | null; attestedAt: Date | null }>();
        m.set(s.systemKey, { startedAt: s.startedAt, attestedAt: s.attestedAt }); setupByClient.set(s.clientId, m);
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
        engineOptOut: r.engineOptOut,
        inheritParentSystems: r.inheritParentSystems,
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
        // modeled = has its OWN systems, OR inherits a modeled parent (SN account hierarchy) — a child
        // with no systems is planned from its parent, so it counts as modeled. Matches `coverage`.
        modeled: r.systems.length > 0 || (r.inheritParentSystems && r.parentId != null && (r.parent?.systems.length ?? 0) > 0),
        parentId: r.parentId,
        parentName: r.parent?.name ?? null,
        parentSystemKeys: r.parent?.systems.map((s) => s.systemKey) ?? [],
        // own = has its own systems; parent = inherits a modeled parent; none = truly unmodeled.
        coverage: r.systems.length > 0 ? "own" : r.inheritParentSystems && r.parentId && (r.parent?.systems.length ?? 0) > 0 ? "parent" : "none",
        // Run-readiness, computed from wired secrets + latest connection tests (own systems).
        readiness: computeClientReadiness({
          systems: r.systems
            .filter((s) => s.mode === "api" && s.secretNames.length > 0 && (s.onboardWhen !== "never" || s.offboardWhen !== "never"))
            .map((s) => ({ systemKey: s.systemKey, secretNames: s.secretNames })),
          secretExternalIds: brokerableSecrets(secretsByClient, r.id, r.parentId),
          testBySystem: testsByClient.get(r.id) ?? new Map(),
          setupBySystem: setupByClient.get(r.id),
          preflightBySystem: preflightByClient.get(r.id),
          rightsBySystem: rightsByClient.get(r.id),
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
          parentId: true,
          systems: { select: { systemKey: true, mode: true, onboardWhen: true, offboardWhen: true, secretNames: true } },
          secrets: { select: { name: true, externalId: true } },
          // Same parent-secret fallback dispatch uses — see brokerableSecrets.
          parent: { select: { secrets: { select: { name: true, externalId: true } } } },
        },
      });
      if (!c) return null;
      const [tests, setupRows] = await Promise.all([
        db.connectionTest.findMany({
          where: { clientId: c.id }, select: { systemKey: true, status: true, fieldsOk: true, rights: true, finishedAt: true }, orderBy: { finishedAt: "desc" },
        }),
        db.systemSetupState.findMany({ where: { clientId: c.id }, select: { systemKey: true, startedAt: true, attestedAt: true } }),
      ]);
      const testBySystem = new Map<string, ConnTestState>();
      const preflightBySystem = new Map<string, boolean | null>();
      const rightsBySystem = new Map<string, RightsState>();
      for (const t of tests) {
        if (testBySystem.has(t.systemKey)) continue;
        testBySystem.set(t.systemKey, t.status === "ok" ? "ok" : t.status === "fail" ? "fail" : "untested");
        preflightBySystem.set(t.systemKey, t.fieldsOk);
        rightsBySystem.set(t.systemKey, rightsStateOf(t.rights));
      }
      return computeClientReadiness({
        systems: c.systems
          .filter((s) => s.mode === "api" && s.secretNames.length > 0 && (s.onboardWhen !== "never" || s.offboardWhen !== "never"))
          .map((s) => ({ systemKey: s.systemKey, secretNames: s.secretNames })),
        secretExternalIds: new Map([
          ...(c.parent?.secrets ?? []).map((s) => [s.name, s.externalId] as const),
          ...c.secrets.map((s) => [s.name, s.externalId] as const), // the child's own win
        ]),
        testBySystem,
        setupBySystem: new Map(setupRows.map((s) => [s.systemKey, { startedAt: s.startedAt, attestedAt: s.attestedAt }])),
        preflightBySystem,
        rightsBySystem,
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
    async setRunCloudOnOwnAgent(slug: string, runCloudOnOwnAgent: boolean) {
      return db.client.update({ where: { slug }, data: { runCloudOnOwnAgent } });
    },
    // FR#26: flag a client as having no runner/agent at all (e.g. Dianthus) — the Fleet M365 sweep
    // (and any other fleet-wide job enumeration) skips it entirely.
    async setNoRunner(slug: string, noRunner: boolean) {
      return db.client.update({ where: { slug }, data: { noRunner } });
    },
    // "Do not use engine": the intake sweep / manual import skip this client's SN cases entirely.
    async setEngineOptOut(slug: string, engineOptOut: boolean) {
      return db.client.update({ where: { slug }, data: { engineOptOut } });
    },
    // Break (or restore) the parent-systems inheritance for a child that doesn't match its parent.
    async setInheritParentSystems(slug: string, inheritParentSystems: boolean) {
      return db.client.update({ where: { slug }, data: { inheritParentSystems } });
    },
    // Materialize the parent's modeling onto the child — exactly what clientForPlanning inherits:
    // the ClientSystem rows plus identity/personas/globals/locations WHERE THE CHILD HAS NONE.
    // Used when breaking inheritance with "keep a copy" so the operator can then edit the steps
    // that differ.
    //
    // Only ever copies onto a child that has NO systems of its own — a child with its own systems
    // never inherited anything (clientForPlanning only falls back when systems.length === 0), so
    // merging the parent's extra systems in would silently add steps that run against the parent's
    // tenant. `nothing_to_copy` is a soft outcome, not a failure: there's simply no modeling to
    // carry over, and the caller still breaks the link.
    async copyParentModeling(
      slug: string
    ): Promise<{ ok: true; copied: number } | { ok: false; code: "not_found" | "no_parent" | "has_own_systems" | "nothing_to_copy" }> {
      const c = await db.client.findUnique({
        where: { slug },
        select: {
          id: true, parentId: true, identity: true, personas: true, globals: true, globalsOffboard: true, locations: true,
          systems: { select: { systemKey: true } },
        },
      });
      if (!c) return { ok: false, code: "not_found" };
      if (!c.parentId) return { ok: false, code: "no_parent" };
      if (c.systems.length > 0) return { ok: false, code: "has_own_systems" };
      const p = await db.client.findUnique({
        where: { id: c.parentId },
        select: {
          identity: true, personas: true, globals: true, globalsOffboard: true, locations: true,
          systems: {
            select: {
              systemKey: true, mode: true, onboardWhen: true, offboardWhen: true, dependsOn: true,
              requiresApproval: true, captureEvidence: true, secretNames: true, config: true,
            },
          },
        },
      });
      if (!p || p.systems.length === 0) return { ok: false, code: "nothing_to_copy" };
      const identityData: Record<string, unknown> = {};
      for (const k of ["identity", "personas", "globals", "globalsOffboard", "locations"] as const) {
        if (c[k] == null && p[k] != null) identityData[k] = p[k] as Prisma.InputJsonValue;
      }
      // skipDuplicates: a double-submitted copy would otherwise trip @@unique([clientId, systemKey])
      // and 500 after the first one already landed.
      await db.$transaction([
        db.clientSystem.createMany({
          data: p.systems.map((s) => ({ ...s, config: (s.config ?? Prisma.DbNull) as Prisma.InputJsonValue, clientId: c.id })),
          skipDuplicates: true,
        }),
        ...(Object.keys(identityData).length ? [db.client.update({ where: { id: c.id }, data: identityData })] : []),
      ]);
      return { ok: true, copied: p.systems.length };
    },
    // Reset a child back to inheriting from its parent (FR #0000023) — the inverse of
    // copyParentModeling. Two granularities, and a scope that decides how far it goes:
    //
    //   WHOLE-CHILD (no systemKey): delete ALL the child's own ClientSystem rows (+ their setup/health/
    //     connection-test state) and null the child's modeling overrides and set inheritParentSystems=
    //     true, so clientForPlanning falls back to the parent again (it only inherits when the child has
    //     ZERO own systems). scope "full" additionally deletes the child's own Secret rows so the
    //     parent's credentials broker.
    //   PER-SYSTEM (systemKey given): reset ONE system to the parent's version. Because systems
    //     inheritance is all-or-nothing, "revert" can't mean "delete and inherit" while other own
    //     systems remain — so we OVERWRITE the child's row for that key with the parent's (or delete it
    //     when the parent has no such system). scope "full" also deletes the child's own Secret rows
    //     named by that system, so the parent's brokered secret wins.
    //
    // Destructive: deleting a child Secret row loses the Delinea REFERENCE (the vault secret survives).
    async resetToParent(
      slug: string,
      opts: { scope: "full" | "systems"; systemKey?: string }
    ): Promise<
      | { ok: true; removedSystems: number; removedSecrets: number; copiedSystem: boolean }
      | { ok: false; code: "not_found" | "no_parent" }
    > {
      const c = await db.client.findUnique({
        where: { slug },
        select: { id: true, parentId: true, systems: { select: { systemKey: true, secretNames: true } } },
      });
      if (!c) return { ok: false, code: "not_found" };
      if (!c.parentId) return { ok: false, code: "no_parent" };
      const parentId = c.parentId;
      const full = opts.scope === "full";

      if (opts.systemKey) {
        const key = opts.systemKey;
        const parentSys = await db.clientSystem.findUnique({
          where: { clientId_systemKey: { clientId: parentId, systemKey: key } },
          select: {
            mode: true, onboardWhen: true, offboardWhen: true, dependsOn: true,
            requiresApproval: true, captureEvidence: true, secretNames: true, config: true,
          },
        });
        const childSys = c.systems.find((s) => s.systemKey === key);
        const secretNames = full ? (childSys?.secretNames ?? []) : [];
        const result = await db.$transaction(async (tx) => {
          // Clear this system's dependent state regardless of overwrite-vs-delete.
          await tx.systemSetupState.deleteMany({ where: { clientId: c.id, systemKey: key } });
          await tx.connHealthState.deleteMany({ where: { clientId: c.id, systemKey: key } });
          await tx.connectionTest.deleteMany({ where: { clientId: c.id, systemKey: key } });
          let removedSystems = 0;
          let copiedSystem = false;
          if (parentSys) {
            const data = {
              mode: parentSys.mode, onboardWhen: parentSys.onboardWhen, offboardWhen: parentSys.offboardWhen,
              dependsOn: parentSys.dependsOn, requiresApproval: parentSys.requiresApproval,
              captureEvidence: parentSys.captureEvidence, secretNames: parentSys.secretNames,
              config: (parentSys.config ?? Prisma.DbNull) as Prisma.InputJsonValue,
            };
            await tx.clientSystem.upsert({
              where: { clientId_systemKey: { clientId: c.id, systemKey: key } },
              update: data,
              create: { clientId: c.id, systemKey: key, ...data },
            });
            copiedSystem = true;
          } else if (childSys) {
            const del = await tx.clientSystem.deleteMany({ where: { clientId: c.id, systemKey: key } });
            removedSystems = del.count;
          }
          let removedSecrets = 0;
          if (secretNames.length) {
            const del = await tx.secret.deleteMany({ where: { clientId: c.id, name: { in: secretNames } } });
            removedSecrets = del.count;
          }
          return { removedSystems, removedSecrets, copiedSystem };
        });
        return { ok: true, ...result };
      }

      // WHOLE-CHILD reset.
      const result = await db.$transaction(async (tx) => {
        const delSys = await tx.clientSystem.deleteMany({ where: { clientId: c.id } });
        await tx.systemSetupState.deleteMany({ where: { clientId: c.id } });
        await tx.connHealthState.deleteMany({ where: { clientId: c.id } });
        await tx.connectionTest.deleteMany({ where: { clientId: c.id } });
        let removedSecrets = 0;
        if (full) {
          const delSec = await tx.secret.deleteMany({ where: { clientId: c.id } });
          removedSecrets = delSec.count;
        }
        await tx.client.update({
          where: { id: c.id },
          data: {
            inheritParentSystems: true,
            identity: Prisma.DbNull, personas: Prisma.DbNull, globals: Prisma.DbNull,
            globalsOffboard: Prisma.DbNull, locations: Prisma.DbNull,
          },
        });
        return { removedSystems: delSys.count, removedSecrets, copiedSystem: false };
      });
      return { ok: true, ...result };
    },
    // Per-client notification override (per-channel object, or null to clear). Shape sanitized by the
    // API route via parseClientOverride before it lands here.
    async setNotifyOverride(slug: string, notifyOverride: unknown | null) {
      return db.client.update({ where: { slug }, data: { notifyOverride: (notifyOverride ?? Prisma.DbNull) as Prisma.InputJsonValue } });
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
    async getRules(slug: string): Promise<{ id: string; personas: unknown; globals: unknown; globalsOffboard: unknown; locations: unknown; systemKeys: string[]; adObjects: unknown; cloudGroups: unknown; systemOnboardOu: Record<string, string>; systemLanes: Record<string, { onboard: string; offboard: string }> } | null> {
      const c = await db.client.findUnique({
        where: { slug },
        select: { id: true, personas: true, globals: true, globalsOffboard: true, locations: true, adObjects: true, cloudGroups: true, systems: { select: { systemKey: true, config: true, onboardWhen: true, offboardWhen: true }, orderBy: { systemKey: "asc" } } },
      });
      if (!c) return null;
      // Systems whose config.onboard.ou is set — the OU the runner actually uses. The rules editor
      // surfaces this so an operator setting an OU in a persona/global fragment is warned that the
      // system's base OU overrides it (own config wins at plan time; see resolveSystemConfig).
      const systemOnboardOu: Record<string, string> = {};
      // Each system's per-lane inclusion enum (never | always | on_request | by_persona). The rules
      // editor uses this to flag which systems are "by persona" — those whose inclusion is decided by
      // persona membership (a key in persona.systems / persona.offboardSystems), which is what the
      // editor lets an operator set explicitly. See FR #0000022.
      const systemLanes: Record<string, { onboard: string; offboard: string }> = {};
      for (const s of c.systems) {
        const ou = (s.config as { onboard?: { ou?: unknown } } | null)?.onboard?.ou;
        if (typeof ou === "string" && ou) systemOnboardOu[s.systemKey] = ou;
        systemLanes[s.systemKey] = { onboard: String(s.onboardWhen), offboard: String(s.offboardWhen) };
      }
      return { id: c.id, personas: c.personas, globals: c.globals, globalsOffboard: c.globalsOffboard, locations: c.locations, systemKeys: c.systems.map((s) => s.systemKey), adObjects: c.adObjects, cloudGroups: c.cloudGroups, systemOnboardOu, systemLanes };
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

    // Read the per-contact intake rules (FR #0000019) + the client's system keys, for the rule
    // editor. parseIntakeRules tolerantly normalizes the stored JSON (a client with no rules yet
    // reads back as { rules: [] }).
    async getIntakeRules(slug: string): Promise<{ id: string; intakeRules: IntakeRulesDoc; systemKeys: string[] } | null> {
      const c = await db.client.findUnique({
        where: { slug },
        select: { id: true, intakeRules: true, systems: { select: { systemKey: true }, orderBy: { systemKey: "asc" } } },
      });
      if (!c) return null;
      return { id: c.id, intakeRules: parseIntakeRules(c.intakeRules), systemKeys: c.systems.map((s) => s.systemKey) };
    },

    // Replace the intake rules doc wholesale (the editor sends the full { rules: [] } array).
    async setIntakeRules(slug: string, doc: IntakeRulesDoc) {
      return db.client.update({ where: { slug }, data: { intakeRules: doc as unknown as Prisma.InputJsonValue } });
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

    // Curated list of email domains offered as per-case choices (the default stays emailDomain /
    // primaryDomain). Sync never touches this list — create seeds [primaryDomain], operators and
    // the M365 tenant pull curate it from there.
    async setDomains(slug: string, domains: string[]) {
      return db.client.update({ where: { slug }, data: { domains } });
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
        // A rights attestation describes a system's CURRENT secrets — clear it when the system's
        // secretNames change (SystemSetupState itself survives edits; it has no FK to these rows).
        const current = await tx.clientSystem.findMany({ where: { clientId: client.id }, select: { systemKey: true, secretNames: true } });
        const currentByKey = new Map(current.map((c) => [c.systemKey, [...c.secretNames].sort().join(",")]));
        const rewired = systems
          .filter((s) => currentByKey.has(s.systemKey) && currentByKey.get(s.systemKey) !== [...(s.secretNames ?? [])].sort().join(","))
          .map((s) => s.systemKey);
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
        // Removed systems take their setup state with them; rewired ones lose only the attestation.
        await tx.systemSetupState.deleteMany({ where: { clientId: client.id, systemKey: { notIn: [...keep] } } });
        if (rewired.length) {
          await tx.systemSetupState.updateMany({
            where: { clientId: client.id, systemKey: { in: rewired }, attestedAt: { not: null } },
            data: { attestedAt: null, attestedBy: null, attestNote: null },
          });
        }
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
          inheritParentSystems: true,
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
      if (systems.length === 0 && c.parentId && c.inheritParentSystems) {
        const p = await db.client.findUnique({
          where: { id: c.parentId },
          select: { systems: { select: { systemKey: true, secretNames: true } } },
        });
        if (p && p.systems.length > 0) systems = p.systems;
      }
      return { clientId: c.id, systems, secrets: c.secrets };
    },

    // Upsert the client's Delinea references (name -> id + label). Stores only references.
    // `actor`: the operator whose edit invalidates the attestations cleared below — without it the
    // clearing row lands as a bare "system" event nobody can trace back to a secret change.
    async upsertSecrets(
      clientId: string,
      entries: { name: string; externalId: string; label?: string | null }[],
      actor?: ActorInput
    ): Promise<void> {
      // Which references actually CHANGE? A rights attestation describes a specific credential —
      // rewiring a secret invalidates it, so clear the attestation on every system that brokers a
      // changed name (the operator re-attests or the probe re-verifies against the new secret).
      const [before, systems] = await Promise.all([
        db.secret.findMany({ where: { clientId, name: { in: entries.map((e) => e.name) } }, select: { name: true, externalId: true } }),
        db.clientSystem.findMany({ where: { clientId }, select: { systemKey: true, secretNames: true } }),
      ]);
      const prior = new Map(before.map((s) => [s.name, s.externalId]));
      const changed = new Set(entries.filter((e) => (prior.get(e.name) ?? "") !== e.externalId).map((e) => e.name));
      const staleSystems = systems.filter((s) => s.secretNames.some((n) => changed.has(n))).map((s) => s.systemKey);
      await db.$transaction([
        ...entries.map((e) =>
          db.secret.upsert({
            where: { clientId_name: { clientId, name: e.name } },
            update: { externalId: e.externalId, label: e.label ?? null },
            create: { clientId, name: e.name, provider: "delinea", externalId: e.externalId, label: e.label ?? null },
          })
        ),
        ...(staleSystems.length
          ? [db.systemSetupState.updateMany({
              where: { clientId, systemKey: { in: staleSystems }, attestedAt: { not: null } },
              data: { attestedAt: null, attestedBy: null, attestNote: null },
            })]
          : []),
      ]);
      if (staleSystems.length) {
        const who = resolveActor(actor, "system");
        await db.auditLog.create({
          data: { actor: who.actor, userId: who.userId, action: "system.setup.attest.cleared", clientId, detail: { systems: staleSystems, reason: "secret reference changed" } },
        }).catch(() => {});
      }
    },

    async writeAudit(entry: AuditEntry): Promise<void> {
      await db.auditLog.create({
        data: {
          actor: entry.actor,
          userId: entry.userId ?? null,
          action: entry.action,
          clientId: entry.clientId ?? null,
          caseRequestId: entry.caseRequestId ?? null,
          detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    },
  };
}

export type ClientRepository = ReturnType<typeof makeClientRepository>;
