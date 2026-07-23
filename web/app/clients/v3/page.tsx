// Clients v3 (the "Version 3" slider serves this at /clients): same denser explorer as v2 via the
// shared _lib/loader.ts (incl. the ServiceNow staleness auto-sync). ClientsExplorer owns its own
// toolbar/filters, so the page just wraps it in a clean v3 header; v1 is retired (no back link).
import Link from "next/link";
import { ClientsExplorer } from "../_components/clients-explorer";
import { loadClientsPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients" };

export default async function ClientsV3Page() {
  const { clients, canRestrict, canArchive, lastSync, modeledCount } = await loadClientsPage();

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
        <div style={{ display: "flex", gap: "1rem", alignSelf: "flex-start" }}>
          <Link href="/clients/v2/review" className="note">✨ AI Review</Link>
          <Link href="/clients/review" className="note">⊞ Config review</Link>
        </div>
      </div>
      <ClientsExplorer clients={clients} canRestrict={canRestrict} canArchive={canArchive} />
    </main>
  );
}
