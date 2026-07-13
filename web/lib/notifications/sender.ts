// Delivery for failure notifications. Every send is BEST-EFFORT (never throws) so a notification
// failure can't affect the caller. Each channel resolves to destination(s) from its default/restricted
// pair + the client's per-channel override, then sends via the right transport.
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import {
  NOTIFICATIONS_SETTING_KEY,
  normalizeSettings,
  type NotificationEvent,
  type NotifChannel,
  type NotificationSettings,
  type WebhookDest,
  type EmailDest,
  type ChannelPair,
  type ChannelOverride,
} from "./types";

export type SendResult = { ok: boolean; error?: string };
export type ChannelResult = { channel: NotifChannel; ok: boolean; error?: string };

// 8s cap so an awaited notification (fired inline from the job-result path) can never hang the runner.
const TIMEOUT_MS = 8000;

// A readable UTC timestamp, e.g. "2026-07-10 14:32 UTC" — locale-free so it's deterministic.
function fmtAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// One plain-text body shared across channels (line-per-fact; Zoom splits it into card segments).
export function messageText(e: NotificationEvent): string {
  const parts = [e.title];
  if (e.clientName) parts.push(`Client: ${e.clientName}`);
  if (e.caseNumber) parts.push(`Case: ${e.caseNumber}`);
  if (e.systemKey) parts.push(`System: ${e.systemKey}`);
  if (e.actor) parts.push(`Ran by: ${e.actor}`);
  if (e.at) parts.push(`At: ${fmtAt(e.at)}`);
  if (e.detail) parts.push(e.detail);
  if (e.url) parts.push(e.url);
  return parts.join("\n");
}

async function postJson(url: string, body: unknown): Promise<SendResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Teams + Slack incoming webhooks accept a simple { text } payload.
export const sendWebhook = (webhookUrl: string, e: NotificationEvent): Promise<SendResult> => postJson(webhookUrl, { text: messageText(e) });

// Zoom Team Chat's incoming webhook needs an `Authorization: <verificationToken>` header. It renders
// REAL line breaks only via the structured card format (`content.head` + a `body` array with one
// `{ type: "message", text }` segment per line); a plain string shows a literal "\n". `?format=full`
// is the format that accepts this structure (see Zoom "send messages via incoming webhooks"). Missing
// token -> HTTP 400/401.
export function zoomBody(e: NotificationEvent): { content: { head: { text: string }; body: { type: "message"; text: string }[] } } {
  const lines = messageText(e).split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const head = lines.shift() ?? e.title;
  return { content: { head: { text: head }, body: lines.map((text) => ({ type: "message", text })) } };
}

export async function sendZoom(webhookUrl: string, token: string, e: NotificationEvent): Promise<SendResult> {
  try {
    let url = webhookUrl;
    try { const u = new URL(webhookUrl); u.searchParams.set("format", "full"); url = u.toString(); } catch { /* leave as-is if not a full URL */ }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(zoomBody(e)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}${token ? "" : " — set the Zoom verification token"}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Email via Microsoft Graph app-only (client credentials). No-ops with a clear reason until NOTIFY_GRAPH_*
// is configured. ONE timeout budget across both fetches (token + sendMail).
export async function sendEmail(recipients: string[], e: NotificationEvent): Promise<SendResult> {
  const tenant = process.env.NOTIFY_GRAPH_TENANT;
  const clientId = process.env.NOTIFY_GRAPH_CLIENT_ID;
  const secret = process.env.NOTIFY_GRAPH_CLIENT_SECRET;
  const sender = process.env.NOTIFY_GRAPH_SENDER;
  if (!tenant || !clientId || !secret || !sender) return { ok: false, error: "email not configured (set NOTIFY_GRAPH_TENANT/CLIENT_ID/CLIENT_SECRET/SENDER)" };
  if (!recipients.length) return { ok: false, error: "no recipients" };
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
      body: JSON.stringify({ message: { subject: e.title, body: { contentType: "Text", content: messageText(e) }, toRecipients: recipients.map((r) => ({ emailAddress: { address: r } })) }, saveToSentItems: false }),
      signal: controller.signal,
    });
    return res.ok ? { ok: true } : { ok: false, error: `sendMail HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Resolve which webhook destination(s) a channel sends to: base = restricted variant for a restricted
// client, else default; a per-client override adds ("also") or replaces ("only") the base. De-duped.
export function resolveWebhookDests(pair: ChannelPair<WebhookDest>, restricted: boolean, ov?: ChannelOverride): WebhookDest[] {
  const base = restricted ? pair.restricted : pair.default;
  const out: WebhookDest[] = [];
  if (ov?.webhookUrl) {
    out.push({ enabled: true, webhookUrl: ov.webhookUrl, token: ov.token ?? "" });
    if (ov.mode === "also" && base.enabled && base.webhookUrl) out.push(base);
  } else if (base.enabled && base.webhookUrl) {
    out.push(base);
  }
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.webhookUrl) ? false : (seen.add(d.webhookUrl), true)));
}

// Same, for email — returns recipient lists (usually 0 or 1, or 2 for "also").
export function resolveEmailDests(pair: ChannelPair<EmailDest>, restricted: boolean, ov?: ChannelOverride): string[][] {
  const base = restricted ? pair.restricted : pair.default;
  const out: string[][] = [];
  if (ov?.recipients?.length) {
    out.push(ov.recipients);
    if (ov.mode === "also" && base.enabled && base.recipients.length) out.push(base.recipients);
  } else if (base.enabled && base.recipients.length) {
    out.push(base.recipients);
  }
  return out;
}

// Send one event to every resolved destination of every channel, in parallel.
export async function sendToChannels(settings: NotificationSettings, e: NotificationEvent): Promise<ChannelResult[]> {
  const ch = settings.channels;
  const restricted = Boolean(e.restricted);
  const ov = e.override ?? {};
  const tasks: Promise<ChannelResult>[] = [];
  for (const d of resolveWebhookDests(ch.teams, restricted, ov.teams)) tasks.push(sendWebhook(d.webhookUrl, e).then((r) => ({ channel: "teams" as const, ...r })));
  for (const d of resolveWebhookDests(ch.slack, restricted, ov.slack)) tasks.push(sendWebhook(d.webhookUrl, e).then((r) => ({ channel: "slack" as const, ...r })));
  for (const d of resolveWebhookDests(ch.zoom, restricted, ov.zoom)) tasks.push(sendZoom(d.webhookUrl, d.token ?? "", e).then((r) => ({ channel: "zoom" as const, ...r })));
  for (const recips of resolveEmailDests(ch.email, restricted, ov.email)) tasks.push(sendEmail(recips, e).then((r) => ({ channel: "email" as const, ...r })));
  return Promise.all(tasks);
}

// Manual announcement (change-log "Send to chat"): fan out ONE message to the chosen side(s) of every
// configured channel pair. audience "all" = each channel's default destination, "restricted" = its
// restricted destination, "both" = both sides. Bypasses the master switch and event toggles (an
// explicit operator action, like a test send) and ignores per-client overrides (announcements are
// global). De-duped across sides so "both" can't double-post when a pair shares one webhook/list.
export type AnnouncementAudience = "all" | "restricted" | "both";
export async function sendAnnouncement(settings: NotificationSettings, audience: AnnouncementAudience, e: NotificationEvent): Promise<ChannelResult[]> {
  const sides = audience === "both" ? [false, true] : [audience === "restricted"];
  const ch = settings.channels;
  const tasks: Promise<ChannelResult>[] = [];
  const seenHooks = new Set<string>(); // keyed channel:url — the same URL reused on another channel still sends
  const seenRecips = new Set<string>();
  for (const restricted of sides) {
    for (const key of ["teams", "slack", "zoom"] as const) {
      for (const d of resolveWebhookDests(ch[key], restricted)) {
        const dedup = `${key}:${d.webhookUrl}`;
        if (seenHooks.has(dedup)) continue;
        seenHooks.add(dedup);
        tasks.push((key === "zoom" ? sendZoom(d.webhookUrl, d.token ?? "", e) : sendWebhook(d.webhookUrl, e)).then((r) => ({ channel: key, ...r })));
      }
    }
    for (const recips of resolveEmailDests(ch.email, restricted)) {
      // Per-RECIPIENT dedup, not per-list: overlapping default/restricted lists must not
      // double-email the shared addresses when the audience is "both".
      const fresh = recips.filter((r) => !seenRecips.has(r.toLowerCase()));
      fresh.forEach((r) => seenRecips.add(r.toLowerCase()));
      if (fresh.length) tasks.push(sendEmail(fresh, e).then((r) => ({ channel: "email" as const, ...r })));
    }
  }
  return Promise.all(tasks);
}

// Send a test to ONE destination (used by the per-destination "Test" buttons). Uses the values passed
// from the form so an operator can verify before saving.
export function sendTest(channel: NotifChannel, dest: { webhookUrl?: string; token?: string; recipients?: string[] }, e: NotificationEvent): Promise<SendResult> {
  if (channel === "zoom") return sendZoom(dest.webhookUrl ?? "", dest.token ?? "", e);
  if (channel === "email") return sendEmail(dest.recipients ?? [], e);
  return sendWebhook(dest.webhookUrl ?? "", e);
}

// Trigger sites call this. Reads config, respects the master switch + per-event toggle, dispatches,
// audits. NEVER throws.
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
      /* notifications must never break the caller */
    }
  }
}
