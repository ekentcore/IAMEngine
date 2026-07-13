// Shared page-data loader for /changelog and /changelog/v2 — the admin gate lives here once so
// the two variants can't drift. Global admins AND ABOVE only (rank gate, not a permission: this
// is release/operations info for admins, mirroring the runner-token API's rank check). The send
// API re-guards server-side; this gate just hides the page.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { ROLE_RANK } from "@/lib/auth/permissions";
import { CHANGELOG } from "@/lib/changelog/entries";

export async function loadChangelogPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.global_admin) redirect("/clients");
  }
  return { entries: CHANGELOG };
}
