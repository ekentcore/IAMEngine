// Connector builder — author low-code connectors (declarative http/browser definitions the runner
// interprets; docs/CONNECTOR_BUILDER.md). Gated on connector.manage (global_admin): publishing a
// connector creates a CLAIMABLE system that runs against real client tenants, so it is admin-only.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { loadConnectors } from "./_lib/loader";
import { ConnectorsAdmin } from "./_components/connectors-admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connectors" };

export default async function ConnectorsPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me) redirect("/login");
    if (!can(me.role, "connector.manage")) redirect("/clients");
  }
  const connectors = await loadConnectors();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Connectors</h1>
          <p className="note">
            Add a new system without writing a module: describe its API as a connector, test it, and publish.
            A published connector becomes a system clients can attach — the runner interprets the definition.
            Import a HAR capture to draft one from requests you made by hand.
          </p>
        </div>
      </div>
      <ConnectorsAdmin initial={connectors} />
    </main>
  );
}
