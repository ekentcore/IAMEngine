// Save a pasted/typed runbook for a client+action: parse the text, then replace that action's
// RunbookSection rows. For clients with no ServiceNow KB (the process lives in a script / a doc).
import type { Action, Lifecycle, PrismaClient } from "@prisma/client";
import { parseRunbookText, type ParsedSection } from "./runbook-parse";
import { CATALOG } from "../generator/system-map";

const laneToDb = (l: string | null): Lifecycle =>
  l === "always" ? "always" : l === "on-request" ? "on_request" : l === "by-persona" ? "by_persona" : "never";

// The transaction-scoped subset of PrismaClient the system sync touches (also satisfied by tx).
type NewSystemRow = {
  clientId: string;
  systemKey: string;
  mode: "api" | "browser" | "manual" | "scim";
  onboardWhen: Lifecycle;
  offboardWhen: Lifecycle;
  dependsOn: string[];
  secretNames: string[];
};

type SystemsDb = {
  clientSystem: {
    findMany(args: { where: { clientId: string }; select: { systemKey: true } }): Promise<{ systemKey: string }[]>;
    createMany(args: { data: NewSystemRow[]; skipDuplicates: boolean }): Promise<unknown>;
  };
  systemCatalog: {
    findMany(args: { where: { key: { in: string[] } }; select: { key: true } }): Promise<{ key: string }[]>;
  };
};

// Create a ClientSystem row (catalog defaults) for each wanted key the client doesn't have yet.
// Existing rows are never modified or removed: the runbook names systems; the systems editor stays
// authoritative for lanes/config/secrets. Returns the keys actually created.
export async function createMissingSystems(tx: SystemsDb, clientId: string, wantedKeys: string[]): Promise<string[]> {
  const wanted = [...new Set(wantedKeys.filter((k) => CATALOG[k]))];
  if (!wanted.length) return [];
  const have = new Set((await tx.clientSystem.findMany({ where: { clientId }, select: { systemKey: true } })).map((r) => r.systemKey));
  // guard against catalog drift: ClientSystem.systemKey is an FK to SystemCatalog — one unknown
  // key must not roll back the whole save
  const inCatalog = new Set(
    (await tx.systemCatalog.findMany({ where: { key: { in: wanted } }, select: { key: true } })).map((r) => r.key)
  );
  const missing = wanted.filter((k) => !have.has(k) && inCatalog.has(k));
  const willHave = new Set([...have, ...missing]);
  // ONE createMany with skipDuplicates (INSERT … ON CONFLICT DO NOTHING): two concurrent syncs for
  // the same client (a save racing the "Sync systems from runbook" button) must not trip the
  // (clientId, systemKey) unique constraint — a failed statement would abort the whole save
  // transaction and lose the operator's edited sections.
  if (missing.length) {
    await tx.clientSystem.createMany({
      data: missing.map((key) => {
        const c = CATALOG[key];
        return {
          clientId,
          systemKey: key,
          mode: c.mode,
          onboardWhen: laneToDb(c.onboard),
          offboardWhen: laneToDb(c.offboard),
          // only deps the client will actually have — a dep on an absent system stalls planning
          dependsOn: (c.dependsOn ?? []).filter((d) => willHave.has(d)),
          secretNames: c.secret ? [c.secret] : [],
        };
      }),
      skipDuplicates: true,
    });
  }
  return missing;
}

// On-demand re-sync for the client page's "Sync systems from runbook" button: wire any modeled
// system the SAVED runbook (either action) references but the client lacks. Same non-destructive
// semantics as the save-time sync.
export async function syncSystemsFromRunbook(db: PrismaClient, slug: string): Promise<{ createdSystems: string[] } | null> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true } });
  if (!client) return null;
  const sections = await db.runbookSection.findMany({
    where: { clientId: client.id, NOT: { systemKey: null } },
    select: { systemKey: true },
  });
  const createdSystems = await db.$transaction((tx) =>
    createMissingSystems(tx, client.id, sections.map((s) => s.systemKey!).filter(Boolean))
  );
  if (createdSystems.length) {
    await db.auditLog.create({
      data: { actor: "ui", action: "client.systems.sync_from_runbook", clientId: client.id, detail: { createdSystems } },
    });
  }
  return { createdSystems };
}

export async function saveRunbook(
  db: PrismaClient,
  slug: string,
  action: Action,
  text: string,
  presetSections?: ParsedSection[], // AI-extracted sections; falls back to the heuristic parse when absent
  kbArticle?: string // the source KB number (from a fetch/import); when omitted, the action's existing KB is preserved
): Promise<{ count: number; sections: ParsedSection[]; createdSystems: string[] } | null> {
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

  const createdSystems: string[] = [];
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

    // Keep the editor's promise ("Save to update the runbook + systems"): a section mapped to a
    // modeled system the client doesn't have yet gets a ClientSystem row with catalog defaults —
    // a KB-sourced client (no seed profile) is otherwise left with a runbook but zero systems,
    // and its cases plan no steps.
    createdSystems.push(
      ...(await createMissingSystems(tx, client.id, sections.map((s) => s.systemKey).filter((k): k is string => Boolean(k))))
    );
  });
  await db.auditLog.create({
    data: {
      actor: "ui",
      action: "client.runbook.set",
      clientId: client.id,
      detail: { action, sections: sections.length, kbArticle: kb, ...(createdSystems.length ? { createdSystems } : {}) },
    },
  });
  return { count: sections.length, sections, createdSystems };
}
