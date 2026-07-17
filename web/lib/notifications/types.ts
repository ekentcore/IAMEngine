// Operator-configurable failure notifications. Config lives in AppSetting under NOTIFICATIONS_SETTING_KEY.
// Every channel (Teams/Slack/Zoom/Email) has a DEFAULT destination (non-restricted clients) and a
// RESTRICTED destination (restricted clients). A per-client override (stored on the Client) can, per
// channel, add to ("also") or replace ("only") the resolved base destination.

export const NOTIFICATIONS_SETTING_KEY = "failure_notifications";

export type NotifChannel = "teams" | "slack" | "zoom" | "email";
// "announcement" is manual-only (change-log sends): it never fires from triggers, bypasses the
// master switch + event toggles like a test send, and deliberately has no NOTIF_EVENTS toggle row.
export type NotifEvent = "caseFailed" | "stepFailed" | "stepWarning" | "autoStopped" | "needsApproval" | "connTestFailed" | "credExpiring" | "backupFailed" | "mailboxPurge" | "announcement";
export type NotifVariant = "default" | "restricted";

export const NOTIF_EVENTS: { key: NotifEvent; label: string }[] = [
  { key: "caseFailed", label: "Case failed" },
  { key: "stepFailed", label: "Step failed" },
  // A step that SUCCEEDED but whose validation read-back missed (verdict "warning" on /runs). Without
  // this, the warnings surfaced on the run report could never reach a chat room.
  { key: "stepWarning", label: "Step warning (succeeded, but validation missed)" },
  { key: "autoStopped", label: "Auto-stopped (wedged)" },
  { key: "needsApproval", label: "Needs approval" },
  { key: "connTestFailed", label: "Connection test failed (scheduled sweep)" },
  { key: "credExpiring", label: "Credential expiring" },
  { key: "backupFailed", label: "Nightly database backup failed" },
  // A licence came off an UNCONVERTED mailbox (client opt-out or an operator's picker answer): the
  // step is verified-green by design — decided is not unresolved — but Exchange will purge the mail
  // after the 30-day grace, and an irreversible clock starting must reach chat, not just the case.
  { key: "mailboxPurge", label: "Mailbox purge scheduled (license removed without convert)" },
];

// kind drives the sender + the form fields (webhook URL vs Zoom URL+token vs email recipients).
export const NOTIF_CHANNELS: { key: NotifChannel; label: string; kind: "webhook" | "zoom" | "email" }[] = [
  { key: "teams", label: "Microsoft Teams", kind: "webhook" },
  { key: "slack", label: "Slack", kind: "webhook" },
  { key: "zoom", label: "Zoom Team Chat", kind: "zoom" },
  { key: "email", label: "Email", kind: "email" },
];

export type WebhookDest = { enabled: boolean; webhookUrl: string; token?: string }; // token: Zoom only
export type EmailDest = { enabled: boolean; recipients: string[] };
export type ChannelPair<D> = { default: D; restricted: D };

export type NotificationSettings = {
  enabled: boolean; // master switch
  channels: {
    teams: ChannelPair<WebhookDest>;
    slack: ChannelPair<WebhookDest>;
    zoom: ChannelPair<WebhookDest>;
    email: ChannelPair<EmailDest>;
  };
  events: Record<NotifEvent, boolean>;
  // Days-before-expiry threshold for credExpiring alerts (the conn sweep reads it). Default 30.
  credExpiryDays?: number;
  updatedAt?: string;
  updatedBy?: string;
};

// Per-client override, per channel. mode "also" = client dest PLUS the resolved base; "only" = alone.
export type ChannelOverride = { mode: "also" | "only"; webhookUrl?: string; token?: string; recipients?: string[] };
export type ClientNotifyOverride = Partial<Record<NotifChannel, ChannelOverride>>;

const emptyWebhook = (): WebhookDest => ({ enabled: false, webhookUrl: "", token: "" });
const emptyEmail = (): EmailDest => ({ enabled: false, recipients: [] });

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: false,
  channels: {
    teams: { default: emptyWebhook(), restricted: emptyWebhook() },
    slack: { default: emptyWebhook(), restricted: emptyWebhook() },
    zoom: { default: emptyWebhook(), restricted: emptyWebhook() },
    email: { default: emptyEmail(), restricted: emptyEmail() },
  },
  events: { caseFailed: true, stepFailed: true, stepWarning: true, autoStopped: true, needsApproval: true, connTestFailed: true, credExpiring: true, backupFailed: true, mailboxPurge: true, announcement: true },
  credExpiryDays: 30,
};

// The payload a trigger site passes to fireNotification.
export type NotificationEvent = {
  event: NotifEvent;
  title: string;
  caseNumber?: string | null;
  clientName?: string | null;
  systemKey?: string | null;
  detail?: string | null;
  actor?: string | null; // the operator who kicked off the run that failed
  at?: string | null; // ISO timestamp of the failure (rendered readable in the message)
  url?: string | null;
  restricted?: boolean; // client is restricted -> route to the "restricted" destination of each channel
  override?: ClientNotifyOverride | null; // this client's per-channel overrides (from the client page)
};

// Pasted webhook URLs and Zoom tokens routinely carry a stray leading/trailing space. A space in the
// Zoom token means a rejected Authorization header, so trim on the way in AND out.
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function normWebhook(raw: unknown): WebhookDest {
  const o = (raw ?? {}) as { enabled?: unknown; webhookUrl?: unknown; token?: unknown };
  return { enabled: Boolean(o.enabled), webhookUrl: str(o.webhookUrl), token: str(o.token) };
}
function normEmail(raw: unknown): EmailDest {
  const o = (raw ?? {}) as { enabled?: unknown; recipients?: unknown };
  return { enabled: Boolean(o.enabled), recipients: Array.isArray(o.recipients) ? o.recipients.map(str).filter(Boolean) : [] };
}
// Accept BOTH the new nested { default, restricted } shape AND the old flat one (where the channel WAS
// the default and a separate `restrictedRaw` — e.g. old `zoomRestricted` — held the restricted dest).
function normPair<D>(raw: unknown, restrictedRaw: unknown, norm: (r: unknown) => D): ChannelPair<D> {
  const o = raw as { default?: unknown; restricted?: unknown } | undefined;
  if (o && (o.default !== undefined || o.restricted !== undefined)) {
    return { default: norm(o.default), restricted: norm(o.restricted) };
  }
  return { default: norm(raw), restricted: norm(restrictedRaw) };
}

export function normalizeSettings(raw: unknown): NotificationSettings {
  const r = (raw ?? {}) as Partial<NotificationSettings> & { channels?: Record<string, unknown> };
  const c = (r.channels ?? {}) as Record<string, unknown>;
  return {
    enabled: Boolean(r.enabled),
    channels: {
      teams: normPair(c.teams, undefined, normWebhook),
      slack: normPair(c.slack, undefined, normWebhook),
      zoom: normPair(c.zoom, c.zoomRestricted, normWebhook), // migrate the old separate zoomRestricted
      email: normPair(c.email, undefined, normEmail),
    },
    events: { ...DEFAULT_NOTIFICATIONS.events, ...(r.events ?? {}) },
    credExpiryDays: typeof r.credExpiryDays === "number" && r.credExpiryDays > 0 ? Math.floor(r.credExpiryDays) : DEFAULT_NOTIFICATIONS.credExpiryDays,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

// Coerce a stored Client.notifyOverride blob into a ClientNotifyOverride. Accepts the NEW per-channel
// shape ({ zoom:{...}, teams:{...} }) and the OLD flat zoom-only shape ({ webhookUrl, token, mode }).
export function parseClientOverride(raw: unknown): ClientNotifyOverride {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown> & { webhookUrl?: unknown; mode?: unknown; token?: unknown };
  // old flat zoom override
  if (str(o.webhookUrl) && (o.mode === "also" || o.mode === "only") && !o.zoom && !o.teams && !o.slack && !o.email) {
    return { zoom: { mode: o.mode, webhookUrl: str(o.webhookUrl), token: str(o.token) } };
  }
  const out: ClientNotifyOverride = {};
  for (const ch of ["teams", "slack", "zoom", "email"] as NotifChannel[]) {
    const ov = o[ch] as { mode?: unknown; webhookUrl?: unknown; token?: unknown; recipients?: unknown } | undefined;
    if (!ov || typeof ov !== "object") continue;
    const mode = ov.mode === "only" ? "only" : "also";
    if (ch === "email") {
      const recipients = Array.isArray(ov.recipients) ? ov.recipients.map(str).filter(Boolean) : [];
      if (recipients.length) out.email = { mode, recipients };
    } else if (str(ov.webhookUrl)) {
      out[ch] = { mode, webhookUrl: str(ov.webhookUrl), token: str(ov.token) };
    }
  }
  return out;
}
