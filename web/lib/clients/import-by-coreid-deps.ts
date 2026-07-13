// Wire importClientByCoreId to the real world: ServiceNow, Azure OpenAI, Prisma. Kept apart from
// the orchestration so that stays unit-testable with fakes.
import type { PrismaClient, Action } from "@prisma/client";
import { snConfigFromEnv, fetchSnAccountByCoreId } from "../servicenow/gateway";
import { findClientKbs } from "../servicenow/kb-discovery";
import { fetchKbArticle } from "../servicenow/kb";
import { makeClientRepository } from "./repository";
import { saveRunbook } from "./runbook-repo";
import { extractRunbookAI } from "./runbook-extract";
import type { ImportDeps } from "./import-by-coreid";

export function makeImportDeps(db: PrismaClient): ImportDeps {
  const repo = makeClientRepository(db);
  const cfg = snConfigFromEnv();

  return {
    // Case-insensitive: the DB stores "CORE1269" but nothing enforces the case, and a lookup that
    // missed would create a duplicate the unique constraint then rejects.
    findByCoreId: (coreId) =>
      db.client.findFirst({
        where: { coreId: { equals: coreId, mode: "insensitive" } },
        select: { id: true, slug: true, name: true },
      }),
    findBySysId: (sysId) => db.client.findUnique({ where: { serviceNowSysId: sysId }, select: { id: true, slug: true, name: true } }),

    // UNCLAIMED rows only — no serviceNowSysId AND no coreId — and only when exactly one such row
    // carries the domain. A row that already belongs to an account is never adopted by another:
    // subsidiaries share their parent's website, so matching on domain alone would hand a child the
    // PARENT's row.
    findUnclaimedByDomain: async (domain) => {
      const rows = await db.client.findMany({
        where: { primaryDomain: domain, serviceNowSysId: null, coreId: null },
        select: { id: true, slug: true, name: true },
        take: 2,
      });
      return rows.length === 1 ? rows[0] : null;
    },

    // Fill in the MISSING ServiceNow keys, nothing else. Emphatically not refreshSnFields: that
    // rewrites name and primaryDomain from the ServiceNow website, and a seeded client's
    // primaryDomain is its EMAIL domain — the one UPNs are minted from. Swapping it silently would
    // provision the next new user at the wrong domain.
    claimForSn: async (clientId, c) => {
      const row = await db.client.findUnique({
        where: { id: clientId },
        select: { serviceNowSysId: true, coreId: true },
      });
      if (!row) return { ok: false, claimed: false, reason: "client disappeared" };

      // serviceNowSysId is @unique. If another row already holds this account's sys_id, these are two
      // rows for one company — say so, instead of dying on a raw constraint error.
      if (!row.serviceNowSysId) {
        const held = await db.client.findUnique({ where: { serviceNowSysId: c.serviceNowSysId }, select: { slug: true } });
        if (held) {
          return { ok: false, claimed: false, reason: `another client (${held.slug}) is already linked to this ServiceNow account — merge them by hand` };
        }
      }

      const data: { serviceNowSysId?: string; coreId?: string; snLastSyncedAt: Date } = { snLastSyncedAt: new Date() };
      if (!row.serviceNowSysId) data.serviceNowSysId = c.serviceNowSysId;
      if (!row.coreId && c.coreId) data.coreId = c.coreId;
      const claimed = data.serviceNowSysId !== undefined || data.coreId !== undefined;
      await db.client.update({ where: { id: clientId }, data });
      return { ok: true, claimed };
    },

    hasSystems: async (clientId) => (await db.clientSystem.count({ where: { clientId } })) > 0,

    // Did the child end up linked to THIS parent? linkParentsBySysId returns 0 both when the parent
    // is absent and when the link already existed, so the count can't be trusted — and a child linked
    // to some OTHER parent must not read as success either.
    linkParent: async (childSysId, parentSysId) => {
      await repo.linkParentsBySysId([{ childSysId, parentSysId }]);
      const [child, parent] = await Promise.all([
        db.client.findUnique({ where: { serviceNowSysId: childSysId }, select: { parentId: true } }),
        db.client.findUnique({ where: { serviceNowSysId: parentSysId }, select: { id: true } }),
      ]);
      return Boolean(parent && child?.parentId === parent.id);
    },
    actionsWithRunbook: async (clientId) => {
      const rows = await db.runbookSection.findMany({
        where: { clientId },
        select: { action: true },
        distinct: ["action"],
      });
      return rows.map((r) => r.action);
    },
    fetchAccount: (coreId) => fetchSnAccountByCoreId(cfg, coreId),
    slugExists: (slug) => repo.slugExists(slug),
    createFromSn: (c, slug) => repo.createFromSn(c, slug),
    findKbs: (domainSysId) => findClientKbs(cfg, domainSysId),
    fetchKb: (number) => fetchKbArticle(cfg, number),
    extract: (text, action) => extractRunbookAI(text, action as "onboard" | "offboard"),
    saveRunbook: async (slug, action: Action, text, sections, kbNumber) => {
      const res = await saveRunbook(db, slug, action, text, sections, kbNumber);
      return res ? { count: res.count, createdSystems: res.createdSystems } : null;
    },
    writeAudit: (entry) => repo.writeAudit(entry),
  };
}
