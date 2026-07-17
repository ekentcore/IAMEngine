// Settings (Global Admin+). Currently: failure notifications. Server component guards the page;
// mutations are additionally guarded server-side by the /api/admin/notifications route.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { getAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "@/lib/notifications/types";
import { AUTO_FIX_SETTING_KEY, type AutoFixSetting } from "@/lib/fixes/fix-tasks";
import { listProvidersMasked } from "@/lib/fixes/providers";
import { NotificationForm } from "./_components/notification-form";
import { RestartServerButton } from "./_components/restart-server-button";
import { AutoFixToggle } from "./_components/auto-fix-toggle";
import { LlmProviders } from "./_components/llm-providers";
import { AgentAutoUpdateToggle } from "./_components/agent-auto-update-toggle";
import { AGENT_AUTO_UPDATE_KEY } from "@/lib/jobs/agent-updates";
import { AgentMigrationSettings } from "./_components/agent-migration-settings";
import { AGENT_MIGRATION_KEY, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
import { loadDbBackupStatus } from "./_lib/loader";
import { DbBackupCard } from "./_components/db-backup-card";
import { MergePrs } from "./_components/merge-prs";
import { isSupervised } from "@/lib/supervised";
import { prsAvailable } from "@/lib/prs/local-prs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  // independent single-row reads — fetch in parallel, not as six serial round trips
  const [rawSettings, autoFix, llmProviders, autoUpdate, dbBackup, agentMigration] = await Promise.all([
    getAppSetting(db, NOTIFICATIONS_SETTING_KEY),
    getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY),
    listProvidersMasked(db),
    getAppSetting<{ enabled?: boolean }>(db, AGENT_AUTO_UPDATE_KEY),
    loadDbBackupStatus(),
    getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY),
  ]);
  const settings = normalizeSettings(rawSettings);
  return (
    <main>
      <h1>Notifications</h1>
      <p className="note" style={{ marginBottom: "1.5rem" }}>
        Get a message when something needs attention — a case fails, a step fails, a runner wedges, or a
        case is waiting on approval. Pick where alerts go and what to alert on below; each channel tells
        you exactly where to find its link.
      </p>
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
      <DbBackupCard initial={dbBackup} />
      <RestartServerButton supervised={isSupervised()}>
        <MergePrs available={await prsAvailable()} />
      </RestartServerButton>
    </main>
  );
}
