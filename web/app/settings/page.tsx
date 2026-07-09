// Settings (Global Admin+). Currently: failure notifications. Server component guards the page;
// mutations are additionally guarded server-side by the /api/admin/notifications route.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { getAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "@/lib/notifications/types";
import { NotificationForm } from "./_components/notification-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  return (
    <main>
      <h1>Notifications</h1>
      <p className="note" style={{ marginBottom: "1.5rem" }}>
        Get a message when something needs attention — a case fails, a step fails, a runner wedges, or a
        case is waiting on approval. Pick where alerts go and what to alert on below; each channel tells
        you exactly where to find its link.
      </p>
      <NotificationForm initial={settings} />
    </main>
  );
}
