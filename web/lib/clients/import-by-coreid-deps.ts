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

    // Only when the domain maps to EXACTLY ONE client. Two clients sharing a website (a parent and
    // its practice, say) must not be reconciled by it — matching the wrong one is worse than
    // creating a new row, and it is the rule syncClientsFromSn already follows.
    findByUniqueDomain: async (domain) => {
      const rows = await db.client.findMany({
        where: { primaryDomain: domain },
        select: { id: true, slug: true, name: true },
        take: 2,
      });
      return rows.length === 1 ? rows[0] : null;
    },
    // Stamp the ServiceNow keys/fields onto a client we matched by domain — but NEVER over a field a
    // human edited in the UI (editedFields); refreshSnFields overwrites everything it is not told to
    // skip, and silently reverting someone's correction is precisely what this import must not do.
    linkToSn: async (clientId, c) => {
      const row = await db.client.findUnique({ where: { id: clientId }, select: { editedFields: true } });
      await repo.refreshSnFields(clientId, c, row?.editedFields ?? []);
    },
    // Reports whether the child ENDS UP linked — not how many links were made. linkParentsBySysId
    // returns 0 both when the parent is missing AND when the link already existed; treating that as
    // failure would nag about a child that is perfectly well linked.
    linkParent: async (childSysId, parentSysId) => {
      await repo.linkParentsBySysId([{ childSysId, parentSysId }]);
      const child = await db.client.findUnique({ where: { serviceNowSysId: childSysId }, select: { parentId: true } });
      return Boolean(child?.parentId);
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
