// GET/POST /api/admin/notifications — read or update the failure-notification config, and send a
// per-destination test. Guarded to settings.manage (global_admin+). Webhook URLs / recipients are
// never written to the audit log.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings, type NotificationEvent, type NotifChannel } from "@/lib/notifications/types";
import { sendTest, sendToChannels } from "@/lib/notifications/sender";

export const dynamic = "force-dynamic";

const CHANNELS = new Set(["teams", "slack", "zoom", "email"]);

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  return NextResponse.json(normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY)));
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  let body: { action?: unknown; settings?: unknown; channel?: unknown; dest?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  // "Test" — send a sample event to ONE destination (the values the operator has in the form for that
  // one channel/variant), so they can verify a webhook/email before saving. Returns that channel's result.
  if (body.action === "test") {
    const channel = String(body.channel) as NotifChannel;
    if (!CHANNELS.has(channel)) return NextResponse.json({ error: "unknown channel" }, { status: 422 });
    const dest = (body.dest ?? {}) as { webhookUrl?: string; token?: string; recipients?: string[] };
    const ev: NotificationEvent = {
      event: "caseFailed",
      title: "iam-engine test notification",
      detail: "This is a test from the Settings page — if you can see this, the channel works.",
    };
    const result = await sendTest(channel, dest, ev);
    await recordAudit("notification.test", { user: g.user, detail: { channel, ok: result.ok, error: result.error ?? null } });
    return NextResponse.json({ ok: result.ok, result });
  }

  // "Test expiry alert" — fire a SAMPLE credential-expiry notification through the real configured
  // routing (every enabled channel's default destination), so an operator can confirm the whole path
  // end to end. Uses sendToChannels (not fireNotification) so it works even before the credExpiring
  // event toggle is on. Uses the SAVED settings, so save first to test what you configured.
  if (body.action === "test_expiry") {
    const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
    const sampleAt = new Date(Date.now() + (settings.credExpiryDays ?? 30) * 86_400_000);
    const ev: NotificationEvent = {
      event: "credExpiring",
      title: "Sample: a credential is expiring",
      clientName: "Acme Corp (sample)",
      systemKey: "m365",
      detail: `Sample alert — the m365 app credential would expire ${sampleAt.toISOString().slice(0, 10)} (${settings.credExpiryDays ?? 30} days out). This is a test.`,
      at: new Date().toISOString(),
    };
    const results = await sendToChannels(settings, ev);
    await recordAudit("notification.test", { user: g.user, detail: { kind: "expiry", channels: results.map((r) => ({ channel: r.channel, ok: r.ok })) } });
    const anyConfigured = results.length > 0;
    return NextResponse.json({ ok: anyConfigured && results.every((r) => r.ok), results, note: anyConfigured ? undefined : "No channels are enabled — turn on a channel and Save first." });
  }

  // Save. Audit records only the master switch + events (never URLs / tokens / recipients).
  const settings = normalizeSettings((body.settings ?? {}) as never);
  const toStore = { ...settings, updatedAt: new Date().toISOString(), updatedBy: g.user?.email ?? "operator" };
  await setAppSetting(db, NOTIFICATIONS_SETTING_KEY, toStore);
  await recordAudit("notification.settings.update", { user: g.user, detail: { enabled: toStore.enabled, events: toStore.events } });
  return NextResponse.json({ ok: true, settings: toStore });
}
