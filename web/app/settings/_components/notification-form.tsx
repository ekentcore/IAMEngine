"use client";

import { useState } from "react";
import { NOTIF_EVENTS, type NotificationSettings, type NotifEvent } from "@/lib/notifications/types";

type TestResult = { channel: string; ok: boolean; error?: string };
const WEBHOOKS = [
  ["teams", "Microsoft Teams"],
  ["slack", "Slack"],
  ["zoom", "Zoom Team Chat"],
] as const;

export function NotificationForm({ initial }: { initial: NotificationSettings }) {
  const [s, setS] = useState<NotificationSettings>(initial);
  // Hold the recipients box as a RAW string so typing a comma (to add a second address) isn't eaten by
  // parse-on-keystroke; it's split into the settings on every change and re-parsed on save anyway.
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
      setStatus(res.ok ? (action === "save" ? "Saved." : "Test sent.") : `${action === "save" ? "Save" : "Test"} failed (${res.status})`);
    } catch {
      setStatus("Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: 640 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
        <input type="checkbox" checked={s.enabled} onChange={(e) => edit((d) => { d.enabled = e.target.checked; })} />
        Enable failure notifications
      </label>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Channels</h2>
        {WEBHOOKS.map(([key, label]) => {
          const ch = s.channels[key];
          return (
            <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input type="checkbox" checked={ch.enabled} onChange={(e) => edit((d) => { d.channels[key].enabled = e.target.checked; })} />
              <span style={{ width: 140 }}>{label}</span>
              <input
                type="url"
                placeholder="incoming webhook URL"
                value={ch.webhookUrl}
                onChange={(e) => edit((d) => { d.channels[key].webhookUrl = e.target.value; })}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={s.channels.email.enabled} onChange={(e) => edit((d) => { d.channels.email.enabled = e.target.checked; })} />
          <span style={{ width: 140 }}>Email (Graph)</span>
          <input
            type="text"
            placeholder="comma-separated recipients"
            value={recipientRaw}
            onChange={(e) => { setRecipientRaw(e.target.value); edit((d) => { d.channels.email.recipients = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); }); }}
            style={{ flex: 1, minWidth: 0 }}
          />
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>Notify on</h2>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {NOTIF_EVENTS.map(({ key, label }) => (
            <label key={key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={s.events[key as NotifEvent]}
                onChange={(e) => edit((d) => { d.events[key as NotifEvent] = e.target.checked; })}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => send("save")} disabled={busy} className="primary">Save</button>
        <button onClick={() => send("test")} disabled={busy}>Send test</button>
        {status && <span className="note">{status}</span>}
      </div>

      {results && (
        <div className="note">
          {results.length === 0
            ? "No channels enabled with a URL — nothing sent."
            : results.map((r) => (
                <div key={r.channel}>
                  {r.ok ? "✓" : "✗"} {r.channel}
                  {r.error ? ` — ${r.error}` : ""}
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
