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
        select: { slug: true, name: true },
      }),
    findBySysId: (sysId) => db.client.findUnique({ where: { serviceNowSysId: sysId }, select: { slug: true, name: true } }),
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
