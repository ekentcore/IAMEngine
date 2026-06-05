// Save a pasted/typed runbook for a client+action: parse the text, then replace that action's
// RunbookSection rows. For clients with no ServiceNow KB (the process lives in a script / a doc).
import type { Action, PrismaClient } from "@prisma/client";
import { parseRunbookText, type ParsedSection } from "./runbook-parse";

export async function saveRunbook(
  db: PrismaClient,
  slug: string,
  action: Action,
  text: string
): Promise<{ count: number; sections: ParsedSection[] } | null> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true } });
  if (!client) return null;
  const sections = parseRunbookText(text);
  await db.$transaction(async (tx) => {
    await tx.runbookSection.deleteMany({ where: { clientId: client.id, action } });
    if (sections.length) {
      await tx.runbookSection.createMany({
        data: sections.map((s) => ({
          clientId: client.id, action, seq: s.seq, systemKey: s.systemKey,
          title: s.title, status: s.status, steps: s.steps,
        })),
      });
    }
  });
  await db.auditLog.create({ data: { actor: "ui", action: "client.runbook.set", clientId: client.id, detail: { action, sections: sections.length } } });
  return { count: sections.length, sections };
}
