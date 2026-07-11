// Shared page-data loader for /clients and /clients/v2: ServiceNow staleness auto-sync, client
// scope, roster query, super-admin check, and Date→ISO serialization live here once. The v2 page
// used to skip the auto-sync and build a narrower row (dropping readiness/ratings/flags) — the
// drift this seam exists to prevent.
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { currentIsSuperAdmin } from "@/lib/auth/acting";
import { syncIfStale } from "@/lib/clients/stale-check";
import type { ClientListItem } from "@/lib/clients/types";
import type { ClientVM } from "../_components/client-vm";

export async function loadClientsPage() {
  await syncIfStale(db, "system:auto");
  const scope = await currentClientScope(db);
  const clients = await makeClientRepository(db).listClients(scope);
  const canRestrict = await currentIsSuperAdmin();

  const lastSync = clients.reduce<Date | null>((max, c) => {
    if (c.snLastSyncedAt && (!max || c.snLastSyncedAt > max)) return c.snLastSyncedAt;
    return max;
  }, null);

  const modeledCount = clients.filter((c) => c.modeled).length;

  return { clients: clients.map(serialize), canRestrict, lastSync, modeledCount };
}

// Dates don't cross the server/client boundary cleanly — hand the island plain strings.
function serialize(c: ClientListItem): ClientVM {
  return { ...c, snLastSyncedAt: c.snLastSyncedAt?.toISOString() ?? null };
}
