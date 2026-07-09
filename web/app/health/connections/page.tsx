// Fleet connection-test roll-up: every client/system preflight result in one place, so you can see
// which wired credentials actually CONNECT (not just resolve) and work the failures. Run a fleet
// sweep from here. Gated to audit.view (read) — the sweep button itself POSTs a guarded route.
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { ConnectionsView } from "./_components/connections-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connection tests" };

export default async function ConnectionsPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
  }
  const tests = await makeRunnerService(db).listAllConnectionTests();
  const rows = tests.map((t) => ({
    client: t.client.name,
    slug: t.client.slug,
    systemKey: t.systemKey,
    status: t.status,
    detail: t.detail ?? t.accessDetail ?? null,
    accessOk: t.accessOk,
    onPrem: t.onPrem,
    finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
    claimedAt: t.claimedAt ? t.claimedAt.toISOString() : null,
  }));

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
