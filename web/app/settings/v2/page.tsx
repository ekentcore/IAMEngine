// Settings v2 (Global Admin+): same NotificationForm as /settings — only the header presentation
// differs (v2 header + back-link). Mutations stay guarded server-side by /api/admin/notifications.
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { getAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "@/lib/notifications/types";
import { AUTO_FIX_SETTING_KEY, type AutoFixSetting } from "@/lib/fixes/fix-tasks";
import { listProvidersMasked } from "@/lib/fixes/providers";
import { NotificationForm } from "../_components/notification-form";
import { FeatureRequestsAdmin } from "../_components/feature-requests-admin";
import { RestartServerButton } from "../_components/restart-server-button";
import { AutoFixToggle } from "../_components/auto-fix-toggle";
import { LlmProviders } from "../_components/llm-providers";
import { loadDbBackupStatus, loadFeatureRequests } from "../_lib/loader";
import { DbBackupCard } from "../_components/db-backup-card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings (v2)" };

export default async function SettingsV2Page() {
  let canHide = true; // auth disabled (dev) acts as super_admin
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
    canHide = can(me.role, "feature_request.hide");
  }
  // independent single-row reads — fetch in parallel, not as five serial round trips
  const [rawSettings, featureRequests, autoFix, llmProviders, dbBackup] = await Promise.all([
    getAppSetting(db, NOTIFICATIONS_SETTING_KEY),
    loadFeatureRequests(),
    getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY),
    listProvidersMasked(db),
    loadDbBackupStatus(),
  ]);
  const settings = normalizeSettings(rawSettings);
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
      <h2 style={{ marginTop: "2.5rem" }}>Feature requests</h2>
      <p className="note" style={{ marginBottom: "1rem" }}>
        Filed by operators via the 💡 button in the header. Set a status (and, when it lands or is
        declined, a note) to keep the queue honest — everyone can watch progress on the{" "}
        <a href="/feature-requests">requests board</a>.
      </p>
      <FeatureRequestsAdmin initial={featureRequests} canHide={canHide} />
      <LlmProviders initial={llmProviders} />
      <AutoFixToggle initialEnabled={autoFix?.enabled === true} />
      <DbBackupCard initial={dbBackup} />
      <RestartServerButton supervised={process.env.IAM_SUPERVISED === "1"} />
    </main>
  );
}
