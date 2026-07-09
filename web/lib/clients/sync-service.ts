// Reconciliation logic: given normalized SN clients + the repository, decide create vs
// update vs reconcile for each, and record the outcome. No HTTP, no env reads — pure
// coordination over injected dependencies, so it is unit-testable with a mock repo.
import type { NormalizedSnClient } from "../servicenow/mappers";
import type { ClientRepository } from "./repository";
import type { SyncResult } from "./types";

// Slug from CORE id (preferred — stable) else a slugified name.
export function deriveSlugFromParts(coreId: string | null, name: string): string {
  if (coreId) return coreId.toLowerCase();
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "client";
}

export function deriveSlug(c: NormalizedSnClient): string {
  return deriveSlugFromParts(c.coreId, c.name);
}

export async function syncClientsFromSn(
  snClients: NormalizedSnClient[],
  repo: ClientRepository,
  actor: string
): Promise<SyncResult> {
  const existing = await repo.indexExisting();
  const bySysId = new Map(existing.filter((e) => e.serviceNowSysId).map((e) => [e.serviceNowSysId!, e]));
  const usedSlugs = new Set(existing.map((e) => e.slug));

  // Reconcile by domain only when a domain maps to exactly ONE client — otherwise the
  // Map would silently drop all but the last, mis-linking the survivors. Ambiguous
  // domains fall through to the (idempotent) create/upsert path instead.
  const domainCounts = new Map<string, number>();
  for (const e of existing) {
    if (e.primaryDomain) domainCounts.set(e.primaryDomain, (domainCounts.get(e.primaryDomain) ?? 0) + 1);
  }
  const byDomain = new Map(
    existing
      .filter((e) => e.primaryDomain && domainCounts.get(e.primaryDomain) === 1)
      .map((e) => [e.primaryDomain, e])
  );

  const result: SyncResult = { total: snClients.length, created: 0, updated: 0, reconciled: 0, errors: [] };
  // Parent links resolve AFTER the main loop — a child can arrive before its parent in the batch.
  const parentLinks: Array<{ childSysId: string; parentSysId: string }> = [];

  for (const c of snClients) {
    try {
      if (!c.serviceNowSysId) {
        result.errors.push({ sysId: "", name: c.name, reason: "missing sys_id" });
        continue;
      }
      if (c.parentSysId) parentLinks.push({ childSysId: c.serviceNowSysId, parentSysId: c.parentSysId });

      const bySys = bySysId.get(c.serviceNowSysId);
      if (bySys) {
        // Already linked — routine field refresh (not audited per-client to avoid noise).
        // Skip fields the user hand-edited (editedFields).
        await repo.refreshSnFields(bySys.id, c, bySys.editedFields);
        result.updated++;
        continue;
      }

      const byDom = c.primaryDomain ? byDomain.get(c.primaryDomain) : undefined;
      if (byDom) {
        // A profile/manual client we hadn't linked yet — stamp it (don't duplicate).
        await repo.refreshSnFields(byDom.id, c, byDom.editedFields);
        bySysId.set(c.serviceNowSysId, byDom);
        result.reconciled++;
        await repo.writeAudit({
          actor,
          action: "client.reconcile",
          clientId: byDom.id,
          detail: { serviceNowSysId: c.serviceNowSysId, coreId: c.coreId, byDomain: c.primaryDomain },
        });
        continue;
      }

      // Net-new roster-only client.
      let slug = deriveSlug(c);
      if (usedSlugs.has(slug)) slug = `${slug}-${c.serviceNowSysId.slice(0, 6)}`;
      usedSlugs.add(slug);
      const id = await repo.createFromSn(c, slug);
      result.created++;
      await repo.writeAudit({
        actor,
        action: "client.create",
        clientId: id,
        detail: { serviceNowSysId: c.serviceNowSysId, coreId: c.coreId, source: "servicenow" },
      });
    } catch (err) {
      result.errors.push({
        sysId: c.serviceNowSysId,
        name: c.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Account hierarchy: children (e.g. CORE2181..89 under CORE1456) inherit the parent's modeled
  // systems at plan time when they have none of their own.
  const parentsLinked = await repo.linkParentsBySysId(parentLinks);

  await repo.writeAudit({
    actor,
    action: "servicenow.sync",
    detail: {
      total: result.total,
      created: result.created,
      updated: result.updated,
      reconciled: result.reconciled,
      parentsLinked,
      errors: result.errors.length,
    },
  });

  return result;
}
