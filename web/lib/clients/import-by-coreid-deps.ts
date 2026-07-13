// Wire importClientByCoreId to the real world: ServiceNow, Azure OpenAI, Prisma. Kept apart from
// the orchestration so that stays unit-testable with fakes.
import type { PrismaClient, Action, Prisma } from "@prisma/client";
import { scopeAllows, type ClientScope } from "../auth/client-scope";
import { normalizeCoreId } from "./core-id";
import { snConfigFromEnv, fetchSnAccountByCoreId, fetchSnAccountById } from "../servicenow/gateway";
import { findClientKbs } from "../servicenow/kb-discovery";
import { fetchKbArticle } from "../servicenow/kb";
import { makeClientRepository } from "./repository";
import { saveRunbook } from "./runbook-repo";
import { extractRunbookAI } from "./runbook-extract";
import type { ImportDeps } from "./import-by-coreid";

export function makeImportDeps(db: PrismaClient, scope: ClientScope = null): ImportDeps {
  const repo = makeClientRepository(db);
  const cfg = snConfigFromEnv();

  return {
    // A restricted client sits outside even an "all"-mode operator's scope unless they were granted
    // it. Importing must not become a side door onto one.
    isVisible: async (clientId) => scopeAllows(scope, clientId),

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
        // Case-INSENSITIVE: ServiceNow's domain is lowercased on the way in, but a hand-added client
        // keeps whatever the operator typed ("Acme.com"). A case-sensitive miss here is not a
        // near-miss — it silently creates a second client row for the same company.
        where: { primaryDomain: { equals: domain, mode: "insensitive" }, serviceNowSysId: null, coreId: null },
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

      // The row is bound to a DIFFERENT ServiceNow account. Carrying on would split one account
      // across two clients: linkParent resolves by sys_id and would touch the OTHER row, while the
      // runbook and systems land on this one. Stop and let a human sort out which is which.
      if (row.serviceNowSysId && row.serviceNowSysId !== c.serviceNowSysId) {
        return { ok: false, claimed: false, reason: "this client is already linked to a different ServiceNow account — check its CORE id" };
      }

      // serviceNowSysId is @unique. If another row already holds this account's sys_id, these are two
      // rows for one company — say so, instead of dying on a raw constraint error. The other row is
      // named only when the operator may see it (it may be a restricted client).
      if (!row.serviceNowSysId) {
        const held = await db.client.findUnique({ where: { serviceNowSysId: c.serviceNowSysId }, select: { id: true, slug: true } });
        if (held) {
          const who = scopeAllows(scope, held.id) ? ` (${held.slug})` : "";
          return { ok: false, claimed: false, reason: `another client${who} is already linked to this ServiceNow account — merge them by hand` };
        }
      }

      // Only the missing keys. NOT snLastSyncedAt: the staleness check takes the MAX across all
      // clients, so stamping it here would tell the app a full roster sync had just run and suppress
      // the real one for 24h — new and renamed ServiceNow accounts would stop appearing.
      const data: { serviceNowSysId?: string; coreId?: string } = {};
      if (!row.serviceNowSysId) data.serviceNowSysId = c.serviceNowSysId;
      if (!row.coreId && c.coreId) data.coreId = normalizeCoreId(c.coreId) ?? c.coreId;
      if (!data.serviceNowSysId && !data.coreId) return { ok: true, claimed: false };

      // Conditional write: re-assert the row is STILL unclaimed. Read-then-write would let two
      // concurrent imports both see a null sys_id and the second overwrite the first's claim,
      // defeating the mismatch guard above. count === 0 means someone got there first.
      const done = await db.client.updateMany({
        where: { id: clientId, ...(data.serviceNowSysId ? { serviceNowSysId: null } : {}) },
        data,
      });
      if (done.count === 0) {
        return { ok: false, claimed: false, reason: "this client was linked to a ServiceNow account by someone else just now — re-run the import" };
      }
      return { ok: true, claimed: true };
    },

    hasSystems: async (clientId) => (await db.clientSystem.count({ where: { clientId } })) > 0,

    // Every row that could stand for this account — by CORE id, by sys_id, or by domain, claimed or
    // not. The caller checks the operator may see them ALL before writing anything, so a decoy row
    // carrying a restricted client's CORE id can't be used to steer the match away from it.
    candidateRows: async (coreId, sysId, domain) => {
      const or: Prisma.ClientWhereInput[] = [{ coreId: { equals: coreId, mode: "insensitive" } }];
      if (sysId) or.push({ serviceNowSysId: sysId });
      if (domain) or.push({ primaryDomain: domain });
      return db.client.findMany({ where: { OR: or }, select: { id: true, slug: true, name: true }, take: 25 });
    },

    // Systems the import did NOT create. A client with a KB-sourced runbook got its systems from a
    // previous import, so re-running may finish what that one started; a client with systems but no
    // KB runbook was configured by hand (a seeded profile, or an operator) and must not have
    // catalog-default lanes bolted onto it.
    isHandConfigured: async (clientId) => {
      const [systems, kbRunbook] = await Promise.all([
        db.clientSystem.count({ where: { clientId } }),
        db.runbookSection.count({ where: { clientId, NOT: { kbArticle: null } } }),
      ]);
      return systems > 0 && kbRunbook === 0;
    },

    fetchAccountBySysId: (sysId) => fetchSnAccountById(cfg, sysId),

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
