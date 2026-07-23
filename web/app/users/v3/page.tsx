// User administration v3 (the "Version 3" slider serves this at /users): same data via the shared
// _lib/loader.ts, rendered in the denser menu-driven UsersView (the v2 flag drives that presentation,
// which is the v3 look). UsersView owns its own toolbar/filters, so the page just gives it a header.
import { UsersView } from "../_components/users-view";
import { loadUsersPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

export default async function UsersV3Page() {
  const { meRole, meId, users, clients, accessRequests } = await loadUsersPage();
  return (
    <main>
      <h1>Users</h1>
      <p className="note">Operators who can sign in, and what each may do. Use <b>Logs</b> to see a single user&rsquo;s audit trail.</p>
      <UsersView users={users} meRole={meRole} clients={clients} meId={meId} accessRequests={accessRequests} v2 />
    </main>
  );
}
