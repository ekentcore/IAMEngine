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
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "user.manage")) redirect("/clients");
  }
  const users = await db.user.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: { id: true, email: true, name: true, role: true, status: true, isBreakGlass: true, authType: true, lastLoginAt: true },
  });
  const vms = users.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null }));
  return (
    <main>
      <h1>Users</h1>
      <p className="note">Operators who can sign in, and what each may do. Roles map to capabilities — see the access guide on the form.</p>
      <UsersView users={vms} />
    </main>
  );
}
