// Apply a ServiceNow pull of a client's Universal Choices to its UniversalChoice rows. The pull owns
// question / label / value; the hand-made group mapping is never touched. A choice ServiceNow no
// longer returns is marked goneAt (kept, mapping and all) so a re-added choice, or an in-flight case
// still carrying it, loses nothing; one that comes back is un-marked.
import type { PrismaClient } from "@prisma/client";
import type { SnChoice } from "../servicenow/universal-choices";

export type SyncResult = { added: number; updated: number; gone: number; total: number };

export async function applyChoiceSync(db: PrismaClient, clientId: string, pulled: readonly SnChoice[], now = new Date()): Promise<SyncResult> {
  const existing = await db.universalChoice.findMany({
    where: { clientId },
    select: { id: true, snSysId: true, question: true, label: true, value: true, goneAt: true },
  });
  const bySysId = new Map(existing.map((e) => [e.snSysId, e]));
  const seen = new Set<string>();
  let added = 0; let updated = 0;
  await db.$transaction(async (tx) => {
    for (const c of pulled) {
      if (seen.has(c.sysId)) continue;
      seen.add(c.sysId);
      const row = bySysId.get(c.sysId);
      if (!row) {
        await tx.universalChoice.create({ data: { clientId, snSysId: c.sysId, question: c.question, label: c.label, value: c.value, syncedAt: now } });
        added++;
      } else {
        const changed = row.question !== c.question || row.label !== c.label || row.value !== c.value || row.goneAt !== null;
        await tx.universalChoice.update({ where: { id: row.id }, data: { question: c.question, label: c.label, value: c.value, syncedAt: now, goneAt: null } });
        if (changed) updated++;
      }
    }
  });
  const goneIds = existing.filter((e) => !seen.has(e.snSysId) && e.goneAt === null).map((e) => e.id);
  if (goneIds.length) await db.universalChoice.updateMany({ where: { id: { in: goneIds } }, data: { goneAt: now } });
  return { added, updated, gone: goneIds.length, total: seen.size };
}
