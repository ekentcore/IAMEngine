// Operator-configurable failure notifications. Config lives in AppSetting under NOTIFICATIONS_SETTING_KEY.
// Every channel (Teams/Slack/Zoom/Email) has a DEFAULT destination (non-restricted clients) and a
// RESTRICTED destination (restricted clients). A per-client override (stored on the Client) can, per
// channel, add to ("also") or replace ("only") the resolved base destination.

export const NOTIFICATIONS_SETTING_KEY = "failure_notifications";

export type NotifChannel = "teams" | "slack" | "zoom" | "email";
export type NotifEvent = "caseFailed" | "stepFailed" | "autoStopped" | "needsApproval";
export type NotifVariant = "default" | "restricted";

export const NOTIF_EVENTS: { key: NotifEvent; label: string }[] = [
  { key: "caseFailed", label: "Case failed" },
  { key: "stepFailed", label: "Step failed" },
  { key: "autoStopped", label: "Auto-stopped (wedged)" },
  { key: "needsApproval", label: "Needs approval" },
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
  events: { caseFailed: true, stepFailed: true, autoStopped: true, needsApproval: true },
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

function normWebhook(raw: unknown): WebhookDest {
  const o = (raw ?? {}) as { enabled?: unknown; webhookUrl?: unknown; token?: unknown };
  return { enabled: Boolean(o.enabled), webhookUrl: typeof o.webhookUrl === "string" ? o.webhookUrl : "", token: typeof o.token === "string" ? o.token : "" };
}
function normEmail(raw: unknown): EmailDest {
  const o = (raw ?? {}) as { enabled?: unknown; recipients?: unknown };
  return { enabled: Boolean(o.enabled), recipients: Array.isArray(o.recipients) ? o.recipients.filter((x): x is string => typeof x === "string") : [] };
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
  if (typeof o.webhookUrl === "string" && o.webhookUrl && (o.mode === "also" || o.mode === "only") && !o.zoom && !o.teams && !o.slack && !o.email) {
    return { zoom: { mode: o.mode, webhookUrl: o.webhookUrl, token: typeof o.token === "string" ? o.token : "" } };
  }
  const out: ClientNotifyOverride = {};
  for (const ch of ["teams", "slack", "zoom", "email"] as NotifChannel[]) {
    const ov = o[ch] as { mode?: unknown; webhookUrl?: unknown; token?: unknown; recipients?: unknown } | undefined;
    if (!ov || typeof ov !== "object") continue;
    const mode = ov.mode === "only" ? "only" : "also";
    if (ch === "email") {
      const recipients = Array.isArray(ov.recipients) ? ov.recipients.filter((x): x is string => typeof x === "string") : [];
      if (recipients.length) out.email = { mode, recipients };
    } else if (typeof ov.webhookUrl === "string" && ov.webhookUrl) {
      out[ch] = { mode, webhookUrl: ov.webhookUrl, token: typeof ov.token === "string" ? ov.token : "" };
    }
  }
  return out;
}
