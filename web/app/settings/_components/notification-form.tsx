"use client";

import { useState } from "react";
import { NOTIF_EVENTS, NOTIF_CHANNELS, type NotificationSettings, type NotifEvent, type NotifChannel, type NotifVariant, type WebhookDest, type EmailDest } from "@/lib/notifications/types";

type TestKey = string; // `${channel}:${variant}`
type TestState = "…" | { ok: boolean; error?: string };

const HELP: Record<NotifChannel, { steps: string; link?: string }> = {
  teams: { steps: "Teams channel → ••• → Connectors → find “Incoming Webhook” → Configure → Create → copy the URL.", link: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook" },
  slack: { steps: "In Slack, add the “Incoming Webhooks” app → choose a channel → copy the Webhook URL.", link: "https://api.slack.com/messaging/webhooks" },
  zoom: { steps: "In Zoom Team Chat, add the “Incoming Webhook” app → pick a channel → copy BOTH the Endpoint URL and the Verification Token.", link: "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067640" },
  email: { steps: "Email sends via Microsoft 365 (Graph). An admin sets NOTIFY_GRAPH_TENANT/CLIENT_ID/CLIENT_SECRET/SENDER in the app env once — then it works." },
};
const VARIANTS: { key: NotifVariant; label: string; hint: string }[] = [
  { key: "default", label: "All clients", hint: "the default destination" },
  { key: "restricted", label: "Restricted clients", hint: "restricted clients go here instead — kept out of the default channel" },
];

export function NotificationForm({ initial }: { initial: NotificationSettings }) {
  const [s, setS] = useState<NotificationSettings>(initial);
  // raw recipient strings per email variant so typing a comma isn't eaten
  const [emailRaw, setEmailRaw] = useState<Record<NotifVariant, string>>({
    default: initial.channels.email.default.recipients.join(", "),
    restricted: initial.channels.email.restricted.recipients.join(", "),
  });
  const [status, setStatus] = useState("");
  const [tests, setTests] = useState<Record<TestKey, TestState>>({});
  const [busy, setBusy] = useState(false);

  const edit = (fn: (d: NotificationSettings) => void) => setS((prev) => { const n = structuredClone(prev); fn(n); return n; });

  async function save() {
    setBusy(true); setStatus("");
    try {
      const res = await fetch("/api/admin/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", settings: s }) });
      setStatus(res.ok ? "Saved." : `Save failed (${res.status}).`);
    } catch { setStatus("Request failed."); } finally { setBusy(false); }
  }

  async function test(channel: NotifChannel, variant: NotifVariant) {
    const key = `${channel}:${variant}`;
    const pair = s.channels[channel];
    const dest = channel === "email"
      ? { recipients: (pair as { [k in NotifVariant]: EmailDest })[variant].recipients }
      : { webhookUrl: (pair as { [k in NotifVariant]: WebhookDest })[variant].webhookUrl, token: (pair as { [k in NotifVariant]: WebhookDest })[variant].token };
    setTests((t) => ({ ...t, [key]: "…" }));
    try {
      const res = await fetch("/api/admin/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", channel, dest }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { error?: string } };
      setTests((t) => ({ ...t, [key]: { ok: Boolean(j.ok), error: j.result?.error } }));
    } catch { setTests((t) => ({ ...t, [key]: { ok: false, error: "request failed" } })); }
  }

  function TestButton({ channel, variant }: { channel: NotifChannel; variant: NotifVariant }) {
    const r = tests[`${channel}:${variant}`];
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button type="button" onClick={() => test(channel, variant)} disabled={r === "…"}>Test</button>
        {r && r !== "…" && <span className="note">{r.ok ? "✓ delivered" : `✗ ${r.error ?? "failed"}`}</span>}
      </span>
    );
  }

  return (
    <div className="notif-form">
      <label className="notif-check notif-master">
        <input type="checkbox" checked={s.enabled} onChange={(e) => edit((d) => { d.enabled = e.target.checked; })} />
        Failure notifications are {s.enabled ? "ON" : "off"}
      </label>
      <p className="note" style={{ marginTop: "-0.9rem" }}>
        Each channel has a destination for <strong>all clients</strong> and one for <strong>restricted clients</strong> (kept
        private). Test any destination on its own before saving. Per-client overrides live on each client&rsquo;s page.
      </p>

      {NOTIF_CHANNELS.map((c) => {
        const pair = s.channels[c.key];
        return (
          <div className="notif-channel" key={c.key}>
            <div className="name" style={{ marginBottom: 4 }}>{c.label}</div>
            {VARIANTS.map((v) => {
              const isEmail = c.kind === "email";
              const wd = (pair as { [k in NotifVariant]: WebhookDest })[v.key];
              const ed = (pair as { [k in NotifVariant]: EmailDest })[v.key];
              const enabled = isEmail ? ed.enabled : wd.enabled;
              return (
                <div key={v.key} className="notif-dest">
                  <label className="notif-check">
                    <input type="checkbox" checked={enabled} onChange={(e) => edit((d) => { (d.channels[c.key] as { [k in NotifVariant]: { enabled: boolean } })[v.key].enabled = e.target.checked; })} />
                    <span style={{ fontWeight: 500 }}>{v.label}</span> <span className="tag">— {v.hint}</span>
                  </label>
                  {isEmail ? (
                    <input type="text" placeholder="recipients, comma-separated" value={emailRaw[v.key]} disabled={!enabled}
                      onChange={(e) => { setEmailRaw((r) => ({ ...r, [v.key]: e.target.value })); edit((d) => { (d.channels.email as { [k in NotifVariant]: EmailDest })[v.key].recipients = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); }); }} />
                  ) : (
                    <input type="url" placeholder="webhook URL (https://…)" value={wd.webhookUrl} disabled={!enabled}
                      onChange={(e) => edit((d) => { (d.channels[c.key] as { [k in NotifVariant]: WebhookDest })[v.key].webhookUrl = e.target.value; })} />
                  )}
                  {c.kind === "zoom" && (
                    <input type="text" placeholder="Zoom verification token" value={wd.token ?? ""} disabled={!enabled}
                      onChange={(e) => edit((d) => { (d.channels.zoom as { [k in NotifVariant]: WebhookDest })[v.key].token = e.target.value; })} />
                  )}
                  <div style={{ marginTop: 6 }}><TestButton channel={c.key} variant={v.key} /></div>
                </div>
              );
            })}
            <p className="note" style={{ marginTop: "0.5rem" }}>
              {HELP[c.key].steps} {HELP[c.key].link && <a href={HELP[c.key].link} target="_blank" rel="noreferrer">Official guide →</a>}
            </p>
          </div>
        );
      })}

      <section>
        <h2>When to alert</h2>
        <div className="notif-events">
          {NOTIF_EVENTS.map(({ key, label }) => (
            <label className="notif-check" key={key}>
              <input type="checkbox" checked={s.events[key as NotifEvent]} onChange={(e) => edit((d) => { d.events[key as NotifEvent] = e.target.checked; })} />
              {label}
            </label>
          ))}
        </div>
      </section>

      <div className="notif-actions">
        <button className="primary" onClick={save} disabled={busy}>Save</button>
        {status && <span className="note">{status}</span>}
      </div>
    </div>
  );
}
