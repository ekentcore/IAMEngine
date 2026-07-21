// Clients v2 (the "Version 2" toggle serves this at /clients): the full clients list in the denser
// explorer shape, plus the module multiselect and coverage filters that only exist here. Same data
// as /clients via the shared _lib/loader.ts (incl. the ServiceNow staleness auto-sync).
import Link from "next/link";
import { ClientsExplorer } from "../_components/clients-explorer";
import { loadClientsPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients (v2)" };

export default async function ClientsV2Page() {
  const { clients, canRestrict, canArchive, lastSync, modeledCount } = await loadClientsPage();

  return (
    <main className="wide">
      <div className="row-between">
        <div>
          <h1>Clients <span className="note">(v2)</span></h1>
          <p className="note">
            {clients.length} total · {modeledCount} modeled ·{" "}
            {lastSync ? `last synced ${lastSync.toLocaleString()}` : "never synced"}
          </p>
        </div>
        <div style={{ display: "flex", gap: "1rem", alignSelf: "flex-start" }}>
          <Link href="/clients/v2/review" className="note">✨ AI Review</Link>
          <Link href="/clients/review" className="note">⊞ Config review</Link>
          <Link href="/clients" className="note">← back to Clients</Link>
        </div>
      </div>
      <ClientsExplorer clients={clients} canRestrict={canRestrict} canArchive={canArchive} />
    </main>
  );
}
