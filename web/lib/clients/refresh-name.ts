// Pull JUST the client's name from ServiceNow and update it — for when an account is renamed in SN
// (e.g. CORE2224) and the roster row went stale. Unlike a hard refresh, this touches ONLY `name`:
// it never clears editedFields or overwrites domain/backbone/identity, so a one-off rename is safe.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv, fetchSnAccountById } from "../servicenow/gateway";
import { normalizeAccount } from "../servicenow/mappers";

export type RefreshNameResult = { ok: boolean; name?: string; previous?: string; changed?: boolean; reason?: string };

export async function refreshClientName(db: PrismaClient, slug: string, actor = "ui"): Promise<RefreshNameResult> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true, name: true, serviceNowSysId: true } });
  if (!client) return { ok: false, reason: "client not found" };
  if (!client.serviceNowSysId) return { ok: false, reason: "no ServiceNow link to refresh from (this client has no customer_account sys_id)" };

  const raw = await fetchSnAccountById(snConfigFromEnv(), client.serviceNowSysId);
  if (!raw) return { ok: false, reason: "the linked ServiceNow account wasn't found (it may have been deleted)" };

  const newName = normalizeAccount(raw).name?.trim();
  if (!newName || newName === "(unnamed)") return { ok: false, reason: "ServiceNow returned no name for this account" };
  if (newName === client.name) return { ok: true, name: newName, changed: false };

  await db.client.update({ where: { id: client.id }, data: { name: newName, snLastSyncedAt: new Date() } });
  await db.auditLog.create({ data: { actor, action: "client.refresh_name", clientId: client.id, detail: { from: client.name, to: newName } } });
  return { ok: true, name: newName, previous: client.name, changed: true };
}
