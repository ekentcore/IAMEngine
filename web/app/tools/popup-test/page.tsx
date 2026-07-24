// Popup test — exercise the admin attention modal in every state without touching real data.
// Same audience as the modal itself (global_admin and above), same redirect-gate shape as
// /tools/db-copy. Scenario runs use forceOpen, which never writes seen-marks; only the explicit
// "Clear seen memory" button touches localStorage.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { ROLE_RANK } from "@/lib/auth/permissions";
import { adminAttentionData } from "@/lib/attention/data";
import { PopupTestView } from "./_components/popup-test-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Popup test" };

export default async function PopupTestPage() {
  let userId: string | null = null;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.global_admin) redirect("/clients");
    userId = me.id;
  }
  const live = await adminAttentionData();
  return <PopupTestView userId={userId} live={live} />;
}
