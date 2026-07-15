// Force-overwrite a client's SN-owned fields from a fresh ServiceNow pull, discarding any manual
// edits (editedFields) — the deliberate escape hatch behind the "Hard refresh" button. Per-client;
// the bulk variant just loops (one SN fetch each).
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv, fetchSnAccountById } from "../servicenow/gateway";
import { normalizeAccount } from "../servicenow/mappers";
import { resolveActor, type ActorInput } from "../auth/actor";
import { makeClientRepository } from "./repository";

export type HardRefreshResult = { slug: string; ok: boolean; reason?: string };

export async function hardRefreshClient(db: PrismaClient, slug: string, actor: ActorInput): Promise<HardRefreshResult> {
  const repo = makeClientRepository(db);
  const client = await db.client.findUnique({ where: { slug }, select: { id: true, serviceNowSysId: true } });
  if (!client) return { slug, ok: false, reason: "not found" };
  if (!client.serviceNowSysId) return { slug, ok: false, reason: "no ServiceNow link to refresh from" };

  const raw = await fetchSnAccountById(snConfigFromEnv(), client.serviceNowSysId);
  if (!raw) return { slug, ok: false, reason: "account not found in ServiceNow" };

  const who = resolveActor(actor);
  await repo.overwriteFromSn(client.id, normalizeAccount(raw));
  await repo.writeAudit({ actor: who.actor, userId: who.userId, action: "client.hard_refresh", clientId: client.id, detail: { serviceNowSysId: client.serviceNowSysId } });
  return { slug, ok: true };
}

export async function hardRefreshClients(db: PrismaClient, slugs: string[], actor: ActorInput): Promise<HardRefreshResult[]> {
  const results: HardRefreshResult[] = [];
  for (const slug of slugs) {
    try {
      results.push(await hardRefreshClient(db, slug, actor));
    } catch (e) {
      results.push({ slug, ok: false, reason: (e as Error).message });
    }
  }
  return results;
}
