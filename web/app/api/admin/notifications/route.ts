// GET/POST /api/admin/notifications — read or update the failure-notification config, and send a test.
// Guarded to settings.manage (global_admin+). Webhook URLs are never written to the audit log.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings, type NotificationEvent } from "@/lib/notifications/types";
import { sendToChannels } from "@/lib/notifications/sender";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  return NextResponse.json(normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY)));
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  let body: { action?: unknown; settings?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const settings = normalizeSettings((body.settings ?? {}) as never);

  // "Send test" — dispatch a sample event to every channel that has a URL, ignoring the master switch
  // and per-event toggles so the operator can verify a webhook/email BEFORE enabling. Returns per-channel
  // results for the UI.
  if (body.action === "test") {
    const ev: NotificationEvent = {
      event: "caseFailed",
      title: "iam-engine test notification",
      detail: "This is a test from the Settings page — if you can see this, the channel works.",
    };
    const forced = { ...settings, enabled: true, events: { ...settings.events, caseFailed: true } };
    const results = await sendToChannels(forced, ev);
    await recordAudit("notification.test", { user: g.user, detail: { results } });
    return NextResponse.json({ ok: true, results });
  }

  // Save. Audit records only the ENABLED flags + events (never the webhook URLs / recipients).
  const toStore = { ...settings, updatedAt: new Date().toISOString(), updatedBy: g.user?.email ?? "operator" };
  await setAppSetting(db, NOTIFICATIONS_SETTING_KEY, toStore);
  await recordAudit("notification.settings.update", {
    user: g.user,
    detail: {
      enabled: toStore.enabled,
      channels: Object.fromEntries(Object.entries(toStore.channels).map(([k, v]) => [k, (v as { enabled: boolean }).enabled])),
      events: toStore.events,
    },
  });
  return NextResponse.json({ ok: true, settings: toStore });
}
