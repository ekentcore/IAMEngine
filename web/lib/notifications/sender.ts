// Delivery for failure notifications. Every send is BEST-EFFORT (never throws) so a notification
// failure can't affect the caller (job result recording / claim). Follows the outbound-HTTP + audit
// pattern from lib/servicenow/worknote.ts.
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import {
  NOTIFICATIONS_SETTING_KEY,
  normalizeSettings,
  type NotificationEvent,
  type NotifChannel,
  type NotificationSettings,
} from "./types";

export type SendResult = { ok: boolean; error?: string };

// Which Zoom channel(s) a notification goes to. Base = the restricted channel for a restricted client,
// else the default. A per-client override adds its own channel ("also") or replaces the base ("only").
// De-duped by URL so one channel is never double-posted.
export function resolveZoomTargets(ch: NotificationSettings["channels"], e: NotificationEvent): { webhookUrl: string; token: string }[] {
  const base = e.restricted ? ch.zoomRestricted : ch.zoom;
  const out: { webhookUrl: string; token: string }[] = [];
  const ov = e.zoomOverride;
  if (ov?.webhookUrl) {
    out.push({ webhookUrl: ov.webhookUrl, token: ov.token ?? "" });
    if (ov.mode === "also" && base.enabled && base.webhookUrl) out.push({ webhookUrl: base.webhookUrl, token: base.token ?? "" });
  } else if (base.enabled && base.webhookUrl) {
    out.push({ webhookUrl: base.webhookUrl, token: base.token ?? "" });
  }
  const seen = new Set<string>();
  return out.filter((t) => (seen.has(t.webhookUrl) ? false : (seen.add(t.webhookUrl), true)));
}

// One plain-text body shared across channels (Teams/Slack/Zoom all accept { text }).
export function messageText(e: NotificationEvent): string {
  const parts = [e.title];
  if (e.clientName) parts.push(`Client: ${e.clientName}`);
  if (e.caseNumber) parts.push(`Case: ${e.caseNumber}`);
  if (e.systemKey) parts.push(`System: ${e.systemKey}`);
  if (e.detail) parts.push(e.detail);
  if (e.url) parts.push(e.url);
  return parts.join("\n");
}

// 8s cap so an awaited notification (fired inline from the job-result path) can never hang the runner.
const TIMEOUT_MS = 8000;

async function postJson(url: string, body: unknown): Promise<SendResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Teams + Slack incoming webhooks accept a simple { text } payload.
export const sendWebhook = (webhookUrl: string, e: NotificationEvent): Promise<SendResult> =>
  postJson(webhookUrl, { text: messageText(e) });

// Zoom Team Chat's incoming webhook is DIFFERENT from Teams/Slack: it needs an `Authorization:
// <verificationToken>` header, a `?format=message` URL param, and a RAW JSON-string body (not { text }).
// Missing the token → HTTP 400. https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067640
export async function sendZoom(webhookUrl: string, token: string, e: NotificationEvent): Promise<SendResult> {
  try {
    const url = /[?&]format=/.test(webhookUrl) ? webhookUrl : webhookUrl + (webhookUrl.includes("?") ? "&" : "?") + "format=message";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(messageText(e)), // a JSON string literal, e.g. "Case failed: …"
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}${token ? "" : " — set the Zoom verification token" }` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Email via Microsoft Graph app-only (client credentials). No-ops with a clear reason until the
// NOTIFY_GRAPH_* env is configured — the webhook channels work without it.
export async function sendEmail(recipients: string[], e: NotificationEvent): Promise<SendResult> {
  const tenant = process.env.NOTIFY_GRAPH_TENANT;
  const clientId = process.env.NOTIFY_GRAPH_CLIENT_ID;
  const secret = process.env.NOTIFY_GRAPH_CLIENT_SECRET;
  const sender = process.env.NOTIFY_GRAPH_SENDER; // the mailbox to send AS (UPN)
  if (!tenant || !clientId || !secret || !sender) {
    return { ok: false, error: "email not configured (set NOTIFY_GRAPH_TENANT/CLIENT_ID/CLIENT_SECRET/SENDER)" };
  }
  if (!recipients.length) return { ok: false, error: "no recipients" };
  // ONE timeout budget across BOTH calls (token + sendMail) — two independent AbortSignal.timeout()s
  // would let the total block up to 2×, defeating the cap that makes awaiting this inline safe.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const tok = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
      signal: controller.signal,
    });
    if (!tok.ok) return { ok: false, error: `token HTTP ${tok.status}` };
    const accessToken = ((await tok.json()) as { access_token?: string }).access_token;
    if (!accessToken) return { ok: false, error: "no access token" };
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: e.title,
          body: { contentType: "Text", content: messageText(e) },
          toRecipients: recipients.map((r) => ({ emailAddress: { address: r } })),
        },
        saveToSentItems: false,
      }),
      signal: controller.signal,
    });
    return res.ok ? { ok: true } : { ok: false, error: `sendMail HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Send one event to every ENABLED channel, in parallel. Returns per-channel results (used by the
// "send test" button and the audit log). Does not read config — callers pass the resolved settings.
export async function sendToChannels(
  settings: ReturnType<typeof normalizeSettings>,
  e: NotificationEvent,
): Promise<{ channel: NotifChannel; ok: boolean; error?: string }[]> {
  const ch = settings.channels;
  const tasks: Promise<{ channel: NotifChannel; ok: boolean; error?: string }>[] = [];
  const web = (channel: NotifChannel, url: string) => sendWebhook(url, e).then((r) => ({ channel, ...r }));
  if (ch.teams.enabled && ch.teams.webhookUrl) tasks.push(web("teams", ch.teams.webhookUrl));
  if (ch.slack.enabled && ch.slack.webhookUrl) tasks.push(web("slack", ch.slack.webhookUrl));
  // Zoom routing: base channel is the RESTRICTED one for a restricted client, else the default. A
  // per-client override (from the client page) either adds its own channel ("also") or replaces the
  // base entirely ("only"). De-dup by URL so the same channel isn't hit twice.
  for (const z of resolveZoomTargets(ch, e)) {
    tasks.push(sendZoom(z.webhookUrl, z.token, e).then((r) => ({ channel: "zoom" as const, ...r })));
  }
  if (ch.email.enabled && ch.email.recipients.length) tasks.push(sendEmail(ch.email.recipients, e).then((r) => ({ channel: "email" as const, ...r })));
  return Promise.all(tasks);
}

// The trigger sites call this. Reads config, respects the master switch + per-event toggle, dispatches
// to enabled channels, audits the attempt. NEVER throws.
export async function fireNotification(e: NotificationEvent): Promise<void> {
  try {
    const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
    if (!settings.enabled) return;
    if (!settings.events[e.event]) return;
    const results = await sendToChannels(settings, e);
    if (results.length) {
      await db.auditLog.create({ data: { actor: "system:notify", action: "notification.sent", detail: { event: e.event, caseNumber: e.caseNumber ?? null, results } } });
    }
  } catch (err) {
    try {
      await db.auditLog.create({ data: { actor: "system:notify", action: "notification.error", detail: { event: e.event, error: err instanceof Error ? err.message : String(err) } } });
    } catch {
      /* swallow — notifications must never break the caller */
    }
  }
}
