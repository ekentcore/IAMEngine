"use client";

import { useState } from "react";
import { NOTIF_EVENTS, type NotificationSettings, type NotifEvent } from "@/lib/notifications/types";

type TestResult = { channel: string; ok: boolean; error?: string };

// Plain-language "where do I get this URL?" help per chat channel.
const WEBHOOKS: { key: "teams" | "slack" | "zoom"; label: string; steps: string; link: string }[] = [
  {
    key: "teams",
    label: "Microsoft Teams",
    steps: "Open the Teams channel → the ••• menu → Connectors → find “Incoming Webhook” → Configure → name it → Create → copy the URL it gives you.",
    link: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook",
  },
  {
    key: "slack",
    label: "Slack",
    steps: "In Slack, add the “Incoming Webhooks” app → choose the channel to post to → copy the Webhook URL.",
    link: "https://api.slack.com/messaging/webhooks",
  },
  {
    key: "zoom",
    label: "Zoom Team Chat",
    steps: "In Zoom Team Chat, add the “Incoming Webhook” app → pick a channel → copy BOTH the Endpoint URL AND the Verification Token it shows (Zoom needs both).",
    link: "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067640",
  },
];

export function NotificationForm({ initial }: { initial: NotificationSettings }) {
  const [s, setS] = useState<NotificationSettings>(initial);
  // Raw string so typing a comma to add a second address isn't eaten by parse-on-keystroke.
  const [recipientRaw, setRecipientRaw] = useState(() => initial.channels.email.recipients.join(", "));
  const [status, setStatus] = useState("");
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (fn: (d: NotificationSettings) => void) =>
    setS((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  async function send(action: "save" | "test") {
    setBusy(true);
    setStatus("");
    setResults(null);
    try {
      const res = await fetch("/api/admin/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, settings: s }),
      });
      const j = (await res.json().catch(() => ({}))) as { results?: TestResult[] };
      if (action === "test") setResults(j.results ?? []);
      setStatus(res.ok ? (action === "save" ? "Saved." : "Test sent — check the results below.") : `${action === "save" ? "Save" : "Test"} failed (${res.status}).`);
    } catch {
      setStatus("Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notif-form">
      <label className="notif-check notif-master">
        <input type="checkbox" checked={s.enabled} onChange={(e) => edit((d) => { d.enabled = e.target.checked; })} />
        Failure notifications are {s.enabled ? "ON" : "off"}
      </label>
      <p className="note" style={{ marginTop: "-0.9rem" }}>
        {s.enabled
          ? "We'll alert the channels below when something goes wrong. Add at least one channel and pick the events to watch."
          : "Turn this on, add a channel, and choose which events should alert you — then Save."}
      </p>

      <section>
        <h2>Where to send alerts</h2>
        <p className="note">
          Each chat app gives you a private &ldquo;incoming webhook&rdquo; link — paste it in and we&rsquo;ll post alerts to that
          channel. The steps to get each link are right here; no code needed.
        </p>
        {WEBHOOKS.map((w) => {
          const ch = s.channels[w.key];
          return (
            <div className="notif-channel" key={w.key}>
              <label className="notif-check">
                <input type="checkbox" checked={ch.enabled} onChange={(e) => edit((d) => { d.channels[w.key].enabled = e.target.checked; })} />
                <span className="name">{w.label}</span>
              </label>
              <input
                type="url"
                placeholder="Paste the webhook URL here  (https://…)"
                value={ch.webhookUrl}
                disabled={!ch.enabled}
                onChange={(e) => edit((d) => { d.channels[w.key].webhookUrl = e.target.value; })}
              />
              {w.key === "zoom" && (
                <input
                  type="text"
                  placeholder="Paste the Zoom verification token here"
                  value={ch.token ?? ""}
                  disabled={!ch.enabled}
                  onChange={(e) => edit((d) => { d.channels.zoom.token = e.target.value; })}
                />
              )}
              <p className="note" style={{ marginTop: "0.4rem" }}>
                {w.steps} <a href={w.link} target="_blank" rel="noreferrer">Official guide →</a>
              </p>
            </div>
          );
        })}

        <div className="notif-channel">
          <label className="notif-check">
            <input type="checkbox" checked={s.channels.email.enabled} onChange={(e) => edit((d) => { d.channels.email.enabled = e.target.checked; })} />
            <span className="name">Email</span> <span className="tag">— needs a one-time admin setup</span>
          </label>
          <input
            type="text"
            placeholder="Who to email, comma-separated  (e.g. team@core.tech, me@core.tech)"
            value={recipientRaw}
            disabled={!s.channels.email.enabled}
            onChange={(e) => { setRecipientRaw(e.target.value); edit((d) => { d.channels.email.recipients = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); }); }}
          />
          <p className="note" style={{ marginTop: "0.4rem" }}>
            Email is sent through Microsoft 365. An admin adds four values to the app&rsquo;s environment once
            (<code>NOTIFY_GRAPH_TENANT</code>, <code>CLIENT_ID</code>, <code>CLIENT_SECRET</code>, <code>SENDER</code>) — until
            then, use a chat channel above. You can still fill this in now; it starts working once those are set.
          </p>
        </div>
      </section>

      <section>
        <h2>When to alert</h2>
        <p className="note" style={{ marginBottom: "0.6rem" }}>Pick the events worth interrupting someone for.</p>
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
        <button className="primary" onClick={() => send("save")} disabled={busy}>Save</button>
        <button onClick={() => send("test")} disabled={busy}>Send test alert</button>
        {status && <span className="note">{status}</span>}
      </div>

      {results && (
        <div className="notif-result">
          {results.length === 0 ? (
            "Nothing sent — no channel is enabled with a URL yet. Tick a channel above, paste its URL, then test."
          ) : (
            results.map((r) => (
              <div key={r.channel}>
                {r.ok ? "✓" : "✗"} <strong>{r.channel}</strong>
                {r.ok ? " — delivered" : ` — ${r.error ?? "failed"}`}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
