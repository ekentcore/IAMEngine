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
import { RestartServerButton } from "../_components/restart-server-button";
import { AutoFixToggle } from "../_components/auto-fix-toggle";
import { LlmProviders } from "../_components/llm-providers";
import { loadDbBackupStatus, loadMaintenance, loadDeploymentStatus } from "../_lib/loader";
import { DbBackupCard } from "../_components/db-backup-card";
import { DeploymentStatusCard } from "../_components/deployment-status-card";
import { MaintenanceCard } from "../_components/maintenance-card";
import { AgentAutoUpdateToggle } from "../_components/agent-auto-update-toggle";
import { AGENT_AUTO_UPDATE_KEY } from "@/lib/jobs/agent-updates";
import { AgentMigrationSettings } from "../_components/agent-migration-settings";
import { AGENT_MIGRATION_KEY, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
import { MergePrs } from "../_components/merge-prs";
import { isSupervised } from "@/lib/supervised";
import { prsAvailable } from "@/lib/prs/local-prs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings (v2)" };

export default async function SettingsV2Page() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  // independent single-row reads — fetch in parallel, not as six serial round trips
  const [rawSettings, autoFix, llmProviders, dbBackup, autoUpdate, agentMigration, maintenance, deployment] = await Promise.all([
    getAppSetting(db, NOTIFICATIONS_SETTING_KEY),
    getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY),
    listProvidersMasked(db),
    loadDbBackupStatus(),
    getAppSetting<{ enabled?: boolean }>(db, AGENT_AUTO_UPDATE_KEY),
    getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY),
    loadMaintenance(),
    loadDeploymentStatus(),
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
      {/* Feature-request management moved to its own page — /feature-requests carries the same
          admin editor for settings.manage holders, and the board for everyone else. */}
      <p className="note" style={{ marginTop: "2.5rem" }}>
        Looking for feature requests? They have their own page now: <a href="/feature-requests">Feature requests</a>.
      </p>
      <LlmProviders initial={llmProviders} />
      <AutoFixToggle initialEnabled={autoFix?.enabled === true} />
      <AgentAutoUpdateToggle initialEnabled={autoUpdate?.enabled !== false} />
      <AgentMigrationSettings initial={{ enabled: agentMigration?.enabled === true, targetUrl: agentMigration?.targetUrl ?? "" }} />
      <MaintenanceCard initial={maintenance} clients={maintenance.clients} />
      <DbBackupCard initial={dbBackup} />
      <RestartServerButton supervised={isSupervised()}>
        <MergePrs available={await prsAvailable()} />
      </RestartServerButton>
      <DeploymentStatusCard status={deployment} />
    </main>
  );
}
