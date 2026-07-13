// Adding a client to the fleet — by CORE-id import or by hand — is a FLEET-WIDE action. Both routes
// resolve or create clients outside any one client's boundary, so the per-client gate the mutation
// routes use (clientSlugInScope) has nothing to hang off: an operator narrowed to a subset could
// otherwise name any client, or mint a row shadowing one they cannot see.
//
// NOTE: currentClientScope returns null ONLY for super admins, so testing it alone would lock out the
// global admins who actually hold client.edit_systems. The access MODE is the right test.
import type { PrismaClient } from "@prisma/client";
import { currentClientScope, type ClientScope } from "./client-scope";

export type FleetAccess = { ok: true; scope: ClientScope } | { ok: false; reason: string };

export async function fleetWideAccess(db: PrismaClient, userId: string): Promise<FleetAccess> {
  const scope = await currentClientScope(db);
  if (scope === null) return { ok: true, scope }; // super admin / auth off

  const me = await db.user.findUnique({ where: { id: userId }, select: { clientAccessMode: true } });
  if (me?.clientAccessMode !== "all") {
    return { ok: false, reason: "adding clients requires access to all clients" };
  }
  // Scope still matters per client: a RESTRICTED client sits outside even an "all"-mode operator's
  // scope unless granted. Hand it back so callers can enforce that per row.
  return { ok: true, scope };
}
