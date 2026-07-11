// Settings v2 (Global Admin+): same NotificationForm as /settings — only the header presentation
// differs (v2 header + back-link). Mutations stay guarded server-side by /api/admin/notifications.
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { getAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "@/lib/notifications/types";
import { NotificationForm } from "../_components/notification-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings (v2)" };

export default async function SettingsV2Page() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  return (
    <main>
      <div className="row-between" style={{ marginBottom: "1.5rem" }}>
        <div>
          <h1>Notifications <span className="note">(v2)</span></h1>
          <p className="note">
            Get a message when something needs attention — a case fails, a step fails, a runner wedges, or a
            case is waiting on approval. Pick where alerts go and what to alert on below; each channel tells
            you exactly where to find its link.
          </p>
        </div>
        <Link href="/settings" className="note" style={{ alignSelf: "flex-start" }}>← back to Settings</Link>
      </div>
      <NotificationForm initial={settings} />
    </main>
  );
}
