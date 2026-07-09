// User administration v2: same as /users, plus a per-user "Logs" link that opens the audit log
// filtered to just that operator (/audit/v2?user=<id>). Reached via the Version 2 toggle.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { UsersView } from "../_components/users-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users (v2)" };

export default async function UsersV2Page() {
  let meRole: "super_admin" | "global_admin" | "ops_manager" | "engineer" | "importer" | "auditor" = "super_admin";
  let meId: string | undefined;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "user.manage")) redirect("/clients");
    meRole = me.role;
    meId = me.id;
  }
  const [users, clients] = await Promise.all([
    db.user.findMany({
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, email: true, name: true, role: true, status: true, isBreakGlass: true, authType: true, lastLoginAt: true,
        clientAccessMode: true,
        clientAccess: { select: { clientId: true, kind: true } },
      },
    }),
    db.client.findMany({ where: { status: "active" }, orderBy: { name: "asc" }, select: { id: true, name: true, restricted: true } }),
  ]);
  const vms = users.map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
    isBreakGlass: u.isBreakGlass, authType: u.authType, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    accessMode: u.clientAccessMode,
    scopeClientIds: u.clientAccess.filter((a) => a.kind === "scope").map((a) => a.clientId),
    grantClientIds: u.clientAccess.filter((a) => a.kind === "grant").map((a) => a.clientId),
  }));
  return (
    <main>
      <h1>Users <span className="note">(v2)</span></h1>
      <p className="note">Operators who can sign in, and what each may do. Use <b>Logs</b> to see a single user&rsquo;s audit trail.</p>
      <UsersView users={vms} meRole={meRole} clients={clients} meId={meId} v2 />
    </main>
  );
}
