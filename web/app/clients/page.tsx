// Clients list (server component). Reads Prisma directly — no HTTP round-trip — and
// auto-syncs from ServiceNow when the roster is stale.
import Link from "next/link";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { currentIsSuperAdmin } from "@/lib/auth/acting";
import { syncIfStale } from "@/lib/clients/stale-check";
import type { ClientListItem } from "@/lib/clients/types";
import { ClientsTable, type ClientVM } from "./_components/clients-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

export default async function ClientsPage() {
  await syncIfStale(db, "system:auto");
  const scope = await currentClientScope(db);
  const clients = await makeClientRepository(db).listClients(scope);
  const canRestrict = await currentIsSuperAdmin();

  const lastSync = clients.reduce<Date | null>((max, c) => {
    if (c.snLastSyncedAt && (!max || c.snLastSyncedAt > max)) return c.snLastSyncedAt;
    return max;
  }, null);

  const modeled = clients.filter((c) => c.modeled).length;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Clients</h1>
          <p className="note">
            {clients.length} total · {modeled} modeled ·{" "}
            {lastSync ? `last synced ${lastSync.toLocaleString()}` : "never synced"}
          </p>
        </div>
        <Link href="/clients/review" className="note" style={{ alignSelf: "flex-start" }}>⊞ Config review (email formats + runbooks)</Link>
      </div>
      <ClientsTable clients={clients.map(serialize)} canRestrict={canRestrict} />
    </main>
  );
}

// Dates don't cross the server/client boundary cleanly — hand the island plain strings.
function serialize(c: ClientListItem): ClientVM {
  return { ...c, snLastSyncedAt: c.snLastSyncedAt?.toISOString() ?? null };
}
