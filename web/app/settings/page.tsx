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
import { FeatureRequestsAdmin } from "./_components/feature-requests-admin";
import { RestartServerButton } from "./_components/restart-server-button";
import { AutoFixToggle } from "./_components/auto-fix-toggle";
import { LlmProviders } from "./_components/llm-providers";
import { AgentAutoUpdateToggle } from "./_components/agent-auto-update-toggle";
import { AGENT_AUTO_UPDATE_KEY } from "@/lib/jobs/agent-updates";
import { loadFeatureRequests } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  const featureRequests = await loadFeatureRequests();
  const autoFix = await getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY);
  const llmProviders = await listProvidersMasked(db);
  const autoUpdate = await getAppSetting<{ enabled?: boolean }>(db, AGENT_AUTO_UPDATE_KEY);
  return (
    <main>
      <h1>Notifications</h1>
      <p className="note" style={{ marginBottom: "1.5rem" }}>
        Get a message when something needs attention — a case fails, a step fails, a runner wedges, or a
        case is waiting on approval. Pick where alerts go and what to alert on below; each channel tells
        you exactly where to find its link.
      </p>
      <NotificationForm initial={settings} />
      <h2 style={{ marginTop: "2.5rem" }}>Feature requests</h2>
      <p className="note" style={{ marginBottom: "1rem" }}>
        Filed by operators via the 💡 button in the header. Set a status (and, when it lands or is
        declined, a note) to keep the queue honest — everyone can watch progress on the{" "}
        <a href="/feature-requests">requests board</a>.
      </p>
      <FeatureRequestsAdmin initial={featureRequests} />
      <LlmProviders initial={llmProviders} />
      <AutoFixToggle initialEnabled={autoFix?.enabled === true} />
      <AgentAutoUpdateToggle initialEnabled={autoUpdate?.enabled !== false} />
      <RestartServerButton supervised={process.env.IAM_SUPERVISED === "1"} />
    </main>
  );
}
