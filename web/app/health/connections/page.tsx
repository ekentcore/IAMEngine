// Fleet connection-test roll-up: every client/system preflight result in one place, so you can see
// which wired credentials actually CONNECT (not just resolve) and work the failures. Run a fleet
// sweep from here. Gated to audit.view (read) — the sweep button itself POSTs a guarded route.
// Data assembly lives in _lib/loader.ts, shared with the denser /health/connections/v2 variant.
import Link from "next/link";
import { ConnectionsView } from "./_components/connections-view";
import { loadConnectionsPage } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connection tests" };

export default async function ConnectionsPage() {
  const rows = await loadConnectionsPage();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Connection tests</h1>
          <p className="note">Per-client/system preflight — proves each credential actually connects + reads, not just that the Delinea reference resolves. <Link href="/health" className="note">← Health</Link></p>
        </div>
      </div>
      <ConnectionsView rows={rows} />
    </main>
  );
}
