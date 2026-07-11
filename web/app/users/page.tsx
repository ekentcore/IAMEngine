// User administration (Global Admin). Data assembly + admin gate live in _lib/loader.ts,
// shared with /users/v2; the client view handles the add form + per-row role/status/password
// actions (requirePermission guards every action server-side).
import { UsersView } from "./_components/users-view";
import { loadUsersPage } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

export default async function UsersPage() {
  const { meRole, meId, users, clients, accessRequests } = await loadUsersPage();
  return (
    <main>
      <h1>Users</h1>
      <p className="note">Operators who can sign in, and what each may do. Roles map to capabilities — see the access guide on the form.</p>
      <UsersView users={users} meRole={meRole} clients={clients} meId={meId} accessRequests={accessRequests} />
    </main>
  );
}
