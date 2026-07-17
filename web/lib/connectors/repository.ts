// Connector CRUD + publish. Publish is the moment a definition becomes executable: it upserts the
// SystemCatalog row (so clients can attach the system) and stamps status=published (only published
// definitions are injected into jobs at claim time — a draft is never claimable).
import type { Connector } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  type ConnectorDefinition,
  definedLanes,
  validateConnectorDefinition,
  validateConnectorKey,
} from "./definition";

export type ConnectorInput = {
  key: string;
  name: string;
  kind: string;
  definition: unknown;
  notes?: string | null;
};

export type SaveResult = { ok: true; connector: Connector } | { ok: false; errors: string[] };

// Built-in guard beyond the "custom-" prefix: never allow a key that exists in SystemCatalog
// without being ours (belt over the prefix's braces — catalog keys are the dispatch namespace).
async function keyCollides(key: string, ownId?: string): Promise<boolean> {
  const existing = await db.connector.findUnique({ where: { key }, select: { id: true } });
  return Boolean(existing && existing.id !== ownId);
}

export async function createConnector(input: ConnectorInput, actor: string): Promise<SaveResult> {
  const keyError = validateConnectorKey(input.key);
  if (keyError) return { ok: false, errors: [keyError] };
  const name = input.name?.trim();
  if (!name || name.length > 80) return { ok: false, errors: ["name must be 1–80 characters"] };
  const v = validateConnectorDefinition(input.kind, input.definition);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (await keyCollides(input.key)) return { ok: false, errors: [`a connector with key "${input.key}" already exists`] };

  const connector = await db.connector.create({
    data: {
      key: input.key,
      name,
      kind: input.kind,
      definition: input.definition as Prisma.InputJsonValue,
      secretNames: v.secretNames,
      notes: input.notes?.trim() || null,
      createdBy: actor,
    },
  });
  await db.auditLog.create({ data: { actor, action: "connector.create", detail: { key: connector.key, kind: connector.kind } } });
  return { ok: true, connector };
}

export async function updateConnector(
  id: string,
  patch: { name?: string; definition?: unknown; notes?: string | null },
  actor: string
): Promise<SaveResult> {
  const existing = await db.connector.findUnique({ where: { id } });
  if (!existing) return { ok: false, errors: ["unknown connector"] };
  const data: Prisma.ConnectorUpdateInput = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 80) return { ok: false, errors: ["name must be 1–80 characters"] };
    data.name = name;
  }
  if (patch.definition !== undefined) {
    const v = validateConnectorDefinition(existing.kind, patch.definition);
    if (!v.ok) return { ok: false, errors: v.errors };
    data.definition = patch.definition as Prisma.InputJsonValue;
    data.secretNames = v.secretNames;
  }
  if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;

  const connector = await db.connector.update({ where: { id }, data });
  await db.auditLog.create({ data: { actor, action: "connector.update", detail: { key: connector.key, edited: Object.keys(data) } } });

  // A published connector's edit takes effect on the NEXT claim (claim injects the stored
  // definition), so there is no separate "republish" step — but keep the catalog flags in step
  // with the lanes the edited definition defines.
  if (connector.status === "published" && patch.definition !== undefined) {
    await syncCatalog(connector);
  }
  return { ok: true, connector };
}

async function syncCatalog(connector: Connector) {
  const lanes = definedLanes(connector.definition as unknown as ConnectorDefinition);
  // Both http AND browser connectors are catalogued mode "api" — deliberately, and matching the one
  // pre-existing browser system (spanning-force-sync, created mode "api"): the job claim query filters
  // `mode: "api"`, and a browser job is routed by its systemKey being in the browser capability gate
  // (browserConnectorKeys in runner-service.claim) + the runner reading config.connector.kind, NOT by
  // the Mode column. Cataloguing a browser connector "browser" would set ClientSystem.mode="browser",
  // its jobs would fall outside the mode:"api" candidate query, and they'd never be claimed.
  const catalog = {
    name: connector.name,
    defaultMode: "api" as const,
    supportsOnboard: lanes.onboard,
    supportsOffboard: lanes.offboard,
    moduleName: "Coretelligent.Connector",
  };
  await db.systemCatalog.upsert({
    where: { key: connector.key },
    create: { key: connector.key, ...catalog, buildTier: 3 },
    update: catalog,
  });
}

export async function publishConnector(id: string, actor: string): Promise<SaveResult> {
  const existing = await db.connector.findUnique({ where: { id } });
  if (!existing) return { ok: false, errors: ["unknown connector"] };
  // Re-validate at the gate — the stored draft may predate a schema tightening.
  const v = validateConnectorDefinition(existing.kind, existing.definition);
  if (!v.ok) return { ok: false, errors: ["definition no longer validates:", ...v.errors] };

  const connector = await db.connector.update({
    where: { id },
    data: { status: "published", publishedAt: new Date(), secretNames: v.secretNames },
  });
  await syncCatalog(connector);
  await db.auditLog.create({ data: { actor, action: "connector.publish", detail: { key: connector.key, kind: connector.kind, secretNames: v.secretNames } } });
  return { ok: true, connector };
}

// Archive stops NEW execution (claim only injects published definitions; an archived connector's
// pending job resolves as "no executor → manual follow-up") but keeps the SystemCatalog row so
// existing ClientSystem rows don't dangle. Un-archive by publishing again.
export async function archiveConnector(id: string, actor: string): Promise<SaveResult> {
  const existing = await db.connector.findUnique({ where: { id } });
  if (!existing) return { ok: false, errors: ["unknown connector"] };
  const connector = await db.connector.update({ where: { id }, data: { status: "archived" } });
  await db.auditLog.create({ data: { actor, action: "connector.archive", detail: { key: connector.key } } });
  return { ok: true, connector };
}

export async function listConnectors(): Promise<Connector[]> {
  return db.connector.findMany({ orderBy: { createdAt: "desc" } });
}

// The published definitions for a set of systemKeys — the claim-time injection source.
export async function publishedDefinitionsByKey(keys: string[]): Promise<Map<string, { kind: string; definition: unknown }>> {
  const customKeys = [...new Set(keys.filter((k) => k.startsWith("custom-")))];
  if (customKeys.length === 0) return new Map();
  const rows = await db.connector.findMany({
    where: { key: { in: customKeys }, status: "published" },
    select: { key: true, kind: true, definition: true },
  });
  return new Map(rows.map((r) => [r.key, { kind: r.kind, definition: r.definition }]));
}

// Published browser-kind connector keys — they join BROWSER_SYSTEMS for the claim capability gate
// (withheld from agents without Playwright) and the central-runner pinning exception.
export async function publishedBrowserConnectorKeys(): Promise<string[]> {
  const rows = await db.connector.findMany({ where: { status: "published", kind: "browser" }, select: { key: true } });
  return rows.map((r) => r.key);
}
