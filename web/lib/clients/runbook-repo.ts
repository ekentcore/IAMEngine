// Save a pasted/typed runbook for a client+action: parse the text, then replace that action's
// RunbookSection rows. For clients with no ServiceNow KB (the process lives in a script / a doc).
import type { Action, PrismaClient } from "@prisma/client";
import { parseRunbookText, type ParsedSection } from "./runbook-parse";

export async function saveRunbook(
  db: PrismaClient,
  slug: string,
  action: Action,
  text: string,
  presetSections?: ParsedSection[], // AI-extracted sections; falls back to the heuristic parse when absent
  kbArticle?: string // the source KB number (from a fetch/import); when omitted, the action's existing KB is preserved
): Promise<{ count: number; sections: ParsedSection[] } | null> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true } });
  if (!client) return null;
  const sections = (presetSections ?? parseRunbookText(text)).map((s, i) => ({ ...s, seq: i }));

  // Stamp the KB number onto the recreated sections so the association survives a re-save. Explicit
  // kbArticle (from a fetch/import) wins; otherwise preserve whatever this action currently carries
  // (so a reorder/paste re-save doesn't drop the KB and lose its Fetch button).
  let kb = kbArticle?.trim() || null;
  if (!kb) {
    const existing = await db.runbookSection.findFirst({
      where: { clientId: client.id, action, NOT: { kbArticle: null } },
      select: { kbArticle: true },
    });
    kb = existing?.kbArticle ?? null;
  }

  await db.$transaction(async (tx) => {
    await tx.runbookSection.deleteMany({ where: { clientId: client.id, action } });
    if (sections.length) {
      await tx.runbookSection.createMany({
        data: sections.map((s) => ({
          clientId: client.id, action, seq: s.seq, systemKey: s.systemKey,
          title: s.title, status: s.status, steps: s.steps, kbArticle: kb,
        })),
      });
    }
  });
  await db.auditLog.create({ data: { actor: "ui", action: "client.runbook.set", clientId: client.id, detail: { action, sections: sections.length, kbArticle: kb } } });
  return { count: sections.length, sections };
}
