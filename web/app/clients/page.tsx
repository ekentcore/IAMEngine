// Clients list (server component). Data assembly — incl. the ServiceNow staleness auto-sync —
// lives in _lib/loader.ts, shared with /clients/v2.
import Link from "next/link";
import { ClientsTable } from "./_components/clients-table";
import { loadClientsPage } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

export default async function ClientsPage() {
  const { clients, canRestrict, lastSync, modeledCount } = await loadClientsPage();

  return (
    <main className="wide">
      <div className="row-between">
        <div>
          <h1>Clients</h1>
          <p className="note">
            {clients.length} total · {modeledCount} modeled ·{" "}
            {lastSync ? `last synced ${lastSync.toLocaleString()}` : "never synced"}
          </p>
        </div>
        <Link href="/clients/review" className="note" style={{ alignSelf: "flex-start" }}>⊞ Config review (email formats + runbooks)</Link>
      </div>
      <ClientsTable clients={clients} canRestrict={canRestrict} />
    </main>
  );
}
