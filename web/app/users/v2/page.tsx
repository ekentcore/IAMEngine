// User administration v2: same data via the shared _lib/loader.ts, plus a per-user "Logs" link
// that opens the audit log filtered to just that operator (/audit/v2?user=<id>).
import { UsersView } from "../_components/users-view";
import { loadUsersPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users (v2)" };

export default async function UsersV2Page() {
  const { meRole, meId, users, clients, accessRequests } = await loadUsersPage();
  return (
    <main>
      <h1>Users <span className="note">(v2)</span></h1>
      <p className="note">Operators who can sign in, and what each may do. Use <b>Logs</b> to see a single user&rsquo;s audit trail.</p>
      <UsersView users={users} meRole={meRole} clients={clients} meId={meId} accessRequests={accessRequests} v2 />
    </main>
  );
}
