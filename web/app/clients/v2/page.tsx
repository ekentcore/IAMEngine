// Clients v2 (test page, no nav link): the clients list with a module multiselect filter.
// Reach it directly at /clients/v2. Reads the same scoped roster as /clients; no ServiceNow
// auto-sync here (keeps the test page side-effect-free).
import Link from "next/link";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import type { ClientListItem } from "@/lib/clients/types";
import { ClientsExplorer, type ClientVM } from "../_components/clients-explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients (v2)" };

export default async function ClientsV2Page() {
  const scope = await currentClientScope(db);
  const clients = await makeClientRepository(db).listClients(scope);
  const modeled = clients.filter((c) => c.modeled).length;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Clients <span className="note">(v2 — filter by modules)</span></h1>
          <p className="note">{clients.length} total · {modeled} modeled · pick modules to see who has them</p>
        </div>
        <div style={{ display: "flex", gap: "1rem", alignSelf: "flex-start" }}>
          <Link href="/clients/review" className="note">⊞ Config review</Link>
          <Link href="/clients" className="note">← back to Clients</Link>
        </div>
      </div>
      <ClientsExplorer clients={clients.map(toVM)} />
    </main>
  );
}

function toVM(c: ClientListItem): ClientVM {
  return {
    id: c.id, slug: c.slug, name: c.name, primaryDomain: c.primaryDomain,
    backbone: c.backbone, status: c.status, coreId: c.coreId, region: c.region,
    systemKeys: c.systemKeys, systemCount: c.systemCount, modeled: c.modeled,
    coverage: c.coverage, parentName: c.parentName,
  };
}
