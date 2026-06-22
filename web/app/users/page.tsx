// User administration (Global Admin). Server component lists users; the client view handles the
// add form + per-row role/status/password actions. requirePermission guards every action server-
// side; this page additionally hides itself from non-admins.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { UsersView } from "./_components/users-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

export default async function UsersPage() {
  // The acting role drives which password resets / role changes the UI offers (server still enforces).
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
    // The client roster for the access editor (which ones are restricted, so the UI can label them).
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
      <h1>Users</h1>
      <p className="note">Operators who can sign in, and what each may do. Roles map to capabilities — see the access guide on the form.</p>
      <UsersView users={vms} meRole={meRole} clients={clients} meId={meId} />
    </main>
  );
}
