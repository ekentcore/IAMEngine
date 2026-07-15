// Refresh a client's locations from ServiceNow's cmn_location table, replacing the generator's guesses.
// Non-destructive when nothing matches (keeps the existing set) so a wrong/absent SN link can't wipe data.
import { Prisma, type PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "../servicenow/gateway";
import { fetchCmnLocations, toLocationsMap } from "../servicenow/locations";
import { resolveActor, type ActorInput } from "../auth/actor";

export type RefreshLocationsResult =
  | { ok: true; count: number; names: string[]; note?: string }
  | { ok: false; error: string };

export async function refreshClientLocations(db: PrismaClient, slug: string, actor: ActorInput = "ui"): Promise<RefreshLocationsResult> {
  const client = await db.client.findUnique({ where: { slug }, select: { id: true, serviceNowSysId: true } });
  if (!client) return { ok: false, error: "client not found" };
  if (!client.serviceNowSysId) return { ok: false, error: "no ServiceNow account linked to this client — can't look up cmn_location" };
  const who = resolveActor(actor);

  let rows;
  try {
    rows = await fetchCmnLocations(snConfigFromEnv(), client.serviceNowSysId);
  } catch (e) {
    return { ok: false, error: `ServiceNow: ${e instanceof Error ? e.message : String(e)}` };
  }
  const map = toLocationsMap(rows);
  const names = Object.keys(map);

  if (names.length === 0) {
    await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "client.locations.refresh", clientId: client.id, detail: { count: 0 } } });
    // Keep whatever's there — a 0 result usually means the cmn_location link field differs, not that the
    // client truly has no offices; overwriting would destroy the (imperfect) existing set.
    return { ok: true, count: 0, names: [], note: "no cmn_location records matched this account — existing locations kept" };
  }

  await db.client.update({ where: { id: client.id }, data: { locations: map as Prisma.InputJsonValue } });
  await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "client.locations.refresh", clientId: client.id, detail: { count: names.length, names } } });
  return { ok: true, count: names.length, names };
}

// Refresh every active, ServiceNow-linked client, SEQUENTIALLY (gentle on the SN API). Returns a
// per-client summary. Non-destructive per client (a 0-match client keeps its existing locations).
export async function refreshAllClientLocations(db: PrismaClient, actor: ActorInput = "ui:bulk"): Promise<{ slug: string; result: RefreshLocationsResult }[]> {
  const clients = await db.client.findMany({
    where: { status: "active", serviceNowSysId: { not: null } },
    select: { slug: true },
    orderBy: { slug: "asc" },
  });
  const out: { slug: string; result: RefreshLocationsResult }[] = [];
  for (const c of clients) {
    out.push({ slug: c.slug, result: await refreshClientLocations(db, c.slug, actor) });
  }
  return out;
}
