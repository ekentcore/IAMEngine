// DB copy — clone the source database (POSTGRES_*) into the destination (POSTGRES_*1): create any
// missing tables at full fidelity, replace the data in tables that already exist. Extremely
// privileged (it copies every client, case, job, audit row and secret REFERENCE), so it's gated on
// settings.manage — super_admin / global_admin only — the same way the API route is.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { DbCopyView } from "./_components/db-copy-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "DB copy" };

export default async function DbCopyPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  return <DbCopyView />;
}
