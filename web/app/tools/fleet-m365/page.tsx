// Fleet Setup — M365: one table of every client with an m365 / entra / exchange system, its M365
// credential health (from the connection-test lane), and in-place fixes — Correct Permissions for a
// missing-permission app registration (keeps the existing secret) or Set up M365 where no working
// credential is wired. Fleet-wide + mutating, so it's gated like the fleet M365 setup: edit_secrets
// AND all-clients access.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { rollupFleetM365Test } from "@/lib/jobs/fleet-m365-test";
import { FleetM365Table } from "./_components/fleet-m365-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet setup — M365" };

export default async function FleetM365Page() {
  // Auth gate mirrors the API route: only an all-clients operator who can edit secrets sees this. When
  // auth is off (local dev) everything is permitted and the scope is unrestricted (null).
  let scope: string[] | null = null;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "client.edit_secrets")) redirect("/clients");
    const access = await fleetWideAccess(db, me.id);
    if (!access.ok) redirect("/clients");
    scope = access.scope;
  }

  const rollup = await rollupFleetM365Test(db, scope);

  return (
    <main>
      <h1>Fleet setup — M365</h1>
      <p className="note" style={{ maxWidth: 720 }}>
        Every client with an <code>m365</code>, <code>entra</code>, or <code>exchange</code> system, and
        the health of its M365 app-registration credential. Tests run automatically when the page opens;
        fix a client in place — <b>Correct permissions</b> reconciles a missing-permission app
        registration while keeping its existing secret, and <b>Set up M365</b> provisions one where no
        working credential is wired. Filter by state to work through the fleet.
      </p>
      <FleetM365Table initial={rollup} />
    </main>
  );
}
