// Settings v3 (Global Admin+): same cards, same server-guarded mutations as /settings and
// /settings/v2 — only the chrome differs. v3 folds the stack into collapsible <details> sections
// (CollapsibleSection) so an operator can hide the parts they aren't touching. v1 is retired, so the
// "← back to Settings" link and the "(v2)" label are gone. Mutations stay guarded server-side by
// their /api/admin/* routes; this page only changes presentation.
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
import { loadDbBackupStatus, loadMaintenance } from "../_lib/loader";
import { DbBackupCard } from "../_components/db-backup-card";
import { MaintenanceCard } from "../_components/maintenance-card";
import { AgentAutoUpdateToggle } from "../_components/agent-auto-update-toggle";
import { AGENT_AUTO_UPDATE_KEY } from "@/lib/jobs/agent-updates";
import { AgentMigrationSettings } from "../_components/agent-migration-settings";
import { AGENT_MIGRATION_KEY, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
import { MergePrs } from "../_components/merge-prs";
import { isSupervised } from "@/lib/supervised";
import { prsAvailable } from "@/lib/prs/local-prs";
import { CollapsibleSection } from "../../_components/collapsible-section";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsV3Page() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  // independent single-row reads — fetch in parallel, not as six serial round trips
  const [rawSettings, autoFix, llmProviders, dbBackup, autoUpdate, agentMigration, maintenance] = await Promise.all([
    getAppSetting(db, NOTIFICATIONS_SETTING_KEY),
    getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY),
    listProvidersMasked(db),
    loadDbBackupStatus(),
    getAppSetting<{ enabled?: boolean }>(db, AGENT_AUTO_UPDATE_KEY),
    getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY),
    loadMaintenance(),
  ]);
  const settings = normalizeSettings(rawSettings);
  return (
    <main>
      <h1 style={{ marginBottom: "1.5rem" }}>Settings</h1>

      {/* NotificationForm renders no heading of its own — the section title carries it, no duplication. */}
      <CollapsibleSection title="Notifications">
        <p className="note">
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
      </CollapsibleSection>

      {/* Each of these cards renders its own <h2>; "AI & automation" is a broader umbrella title, so
          those headings read as the section's contents rather than duplicating the section title. */}
      <CollapsibleSection title="AI & automation">
        <LlmProviders initial={llmProviders} />
        <AutoFixToggle initialEnabled={autoFix?.enabled === true} />
        <AgentAutoUpdateToggle initialEnabled={autoUpdate?.enabled !== false} />
        <AgentMigrationSettings initial={{ enabled: agentMigration?.enabled === true, targetUrl: agentMigration?.targetUrl ?? "" }} />
      </CollapsibleSection>

      {/* MaintenanceCard renders its own <h2>Maintenance &amp; drain</h2>. */}
      <CollapsibleSection title="Maintenance & drain">
        <MaintenanceCard initial={maintenance} clients={maintenance.clients} />
      </CollapsibleSection>

      {/* DbBackupCard's own <h2> is "Database backups" — specific content under the broader "Backups". */}
      <CollapsibleSection title="Backups">
        <DbBackupCard initial={dbBackup} />
      </CollapsibleSection>

      {/* RestartServerButton already renders its own <h2>Server</h2>. Wrapping it in a "Server" section
          would repeat that heading verbatim, so this card is left unwrapped to avoid the duplicate. */}
      <RestartServerButton supervised={isSupervised()}>
        <MergePrs available={await prsAvailable()} />
      </RestartServerButton>
    </main>
  );
}
