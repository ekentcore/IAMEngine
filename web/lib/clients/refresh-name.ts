// Pull JUST the client's name from ServiceNow and update it — for when an account is renamed in SN
// (e.g. CORE2224) and the roster row went stale. Unlike a hard refresh, this touches ONLY `name`:
// it never clears editedFields or overwrites domain/backbone/identity, so a one-off rename is safe.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv, fetchSnAccountById, fetchSnAccountByCoreId } from "../servicenow/gateway";
import { normalizeAccount } from "../servicenow/mappers";

export type RefreshNameResult = { ok: boolean; name?: string; previous?: string; changed?: boolean; reason?: string };

export async function refreshClientName(db: PrismaClient, slug: string, actor = "ui"): Promise<RefreshNameResult> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true, name: true, serviceNowSysId: true, coreId: true } });
  if (!client) return { ok: false, reason: "client not found" };

  const cfg = snConfigFromEnv();
  // Prefer the stored sys_id link; fall back to looking the account up by its CORE id (u_core_id) —
  // so a client roster row that never got a sys_id can still self-heal off the CORE id.
  let raw = client.serviceNowSysId ? await fetchSnAccountById(cfg, client.serviceNowSysId) : null;
  if (!raw && client.coreId) raw = await fetchSnAccountByCoreId(cfg, client.coreId);
  if (!raw) {
    return { ok: false, reason: client.serviceNowSysId || client.coreId
      ? "couldn't find this account in ServiceNow (the sys_id link is stale and no customer_account matches the CORE id)"
      : "no ServiceNow link to refresh from (this client has neither a sys_id nor a CORE id)" };
  }

  const normalized = normalizeAccount(raw);
  const newName = normalized.name?.trim();
  if (!newName || newName === "(unnamed)") return { ok: false, reason: "ServiceNow returned no name for this account" };

  // Backfill the sys_id link when we resolved via CORE id, so future refreshes are direct.
  const backfillSysId = !client.serviceNowSysId && normalized.serviceNowSysId ? { serviceNowSysId: normalized.serviceNowSysId } : {};
  if (newName === client.name) {
    if (Object.keys(backfillSysId).length) await db.client.update({ where: { id: client.id }, data: backfillSysId });
    return { ok: true, name: newName, changed: false };
  }

  await db.client.update({ where: { id: client.id }, data: { name: newName, snLastSyncedAt: new Date(), ...backfillSysId } });
  await db.auditLog.create({ data: { actor, action: "client.refresh_name", clientId: client.id, detail: { from: client.name, to: newName } } });
  return { ok: true, name: newName, previous: client.name, changed: true };
}
