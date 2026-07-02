// Operator-configurable failure notifications. Config lives in the AppSetting table under
// NOTIFICATIONS_SETTING_KEY (JSON), editable by global_admin+ on the Settings page. Channels:
// Teams / Slack / Zoom Team Chat via incoming webhooks, and email via Microsoft Graph (app-only).

export const NOTIFICATIONS_SETTING_KEY = "failure_notifications";

export type NotifChannel = "teams" | "slack" | "zoom" | "email";
export type NotifEvent = "caseFailed" | "stepFailed" | "autoStopped" | "needsApproval";

export const NOTIF_EVENTS: { key: NotifEvent; label: string }[] = [
  { key: "caseFailed", label: "Case failed" },
  { key: "stepFailed", label: "Step failed" },
  { key: "autoStopped", label: "Auto-stopped (wedged)" },
  { key: "needsApproval", label: "Needs approval" },
];

// token is only used by Zoom (its incoming webhook requires an Authorization verification token);
// Teams/Slack ignore it.
export type WebhookChannel = { enabled: boolean; webhookUrl: string; token?: string };
export type EmailChannel = { enabled: boolean; recipients: string[] };

export type NotificationSettings = {
  enabled: boolean; // master switch
  channels: {
    teams: WebhookChannel;
    slack: WebhookChannel;
    zoom: WebhookChannel; // default Zoom channel — NON-restricted clients (e.g. "IAM")
    zoomRestricted: WebhookChannel; // Zoom channel for RESTRICTED clients (e.g. "Internal")
    email: EmailChannel;
  };
  events: Record<NotifEvent, boolean>;
  updatedAt?: string;
  updatedBy?: string;
};

// A client-specific Zoom override (stored per-Client, resolved at the trigger site and passed on the
// event). mode "also" = client channel PLUS the restricted/default base; "only" = client channel alone.
export type ZoomOverride = { webhookUrl: string; token: string; mode: "also" | "only" };

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: false,
  channels: {
    teams: { enabled: false, webhookUrl: "" },
    slack: { enabled: false, webhookUrl: "" },
    zoom: { enabled: false, webhookUrl: "", token: "" },
    zoomRestricted: { enabled: false, webhookUrl: "", token: "" },
    email: { enabled: false, recipients: [] },
  },
  events: { caseFailed: true, stepFailed: true, autoStopped: true, needsApproval: true },
};

// The payload a trigger site passes to fireNotification.
export type NotificationEvent = {
  event: NotifEvent;
  title: string; // short subject line, e.g. "Case failed: UM0028740 (Acme)"
  caseNumber?: string | null;
  clientName?: string | null;
  systemKey?: string | null;
  detail?: string | null; // error / reason
  url?: string | null; // absolute link to the case
  restricted?: boolean; // the client is restricted -> route Zoom to the "restricted" channel
  zoomOverride?: ZoomOverride | null; // this client's own Zoom channel (from the client page), if set
};

// Merge a stored (possibly partial / older-shape) settings blob onto the defaults so the UI + sender
// always see a complete object.
export function normalizeSettings(raw: Partial<NotificationSettings> | null | undefined): NotificationSettings {
  const d = DEFAULT_NOTIFICATIONS;
  const c = (raw?.channels ?? {}) as Partial<NotificationSettings["channels"]>;
  return {
    enabled: Boolean(raw?.enabled),
    channels: {
      teams: { ...d.channels.teams, ...(c.teams ?? {}) },
      slack: { ...d.channels.slack, ...(c.slack ?? {}) },
      zoom: { ...d.channels.zoom, ...(c.zoom ?? {}) },
      zoomRestricted: { ...d.channels.zoomRestricted, ...(c.zoomRestricted ?? {}) },
      email: { ...d.channels.email, ...(c.email ?? {}), recipients: c.email?.recipients ?? [] },
    },
    events: { ...d.events, ...(raw?.events ?? {}) },
    updatedAt: raw?.updatedAt,
    updatedBy: raw?.updatedBy,
  };
}
