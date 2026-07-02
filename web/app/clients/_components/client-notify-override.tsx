"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ZoomOverride } from "@/lib/notifications/types";

// Per-client Zoom notification override, shown on the client detail page. Sets THIS client's own Zoom
// channel: "also" = send here AND the global default/restricted channel; "only" = send here alone.
export function ClientNotifyOverride({ slug, initial }: { slug: string; initial: ZoomOverride | null }) {
  const router = useRouter();
  const [url, setUrl] = useState(initial?.webhookUrl ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [mode, setMode] = useState<"also" | "only">(initial?.mode ?? "also");
  const [has, setHas] = useState(Boolean(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit(clear: boolean) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-notify-override", override: clear ? null : { webhookUrl: url, token, mode } }),
      });
      if (!res.ok) {
        setMsg((await res.json().catch(() => ({}))).error ?? "Could not save.");
        return;
      }
      if (clear) { setUrl(""); setToken(""); setMode("also"); setHas(false); setMsg("Removed — this client uses the default routing."); }
      else { setHas(true); setMsg("Saved."); }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const radioStyle = { width: "auto", margin: 0, flex: "none" as const };

  return (
    <div style={{ maxWidth: 560 }}>
      <p className="note">
        By default this client&rsquo;s failure alerts follow the global Zoom routing. Add a channel here to send them
        to <strong>this client&rsquo;s own</strong> Zoom channel — useful when a client wants their alerts in their own space.
      </p>
      <label>Zoom webhook URL</label>
      <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://integrations.zoom.us/chat/webhooks/…" />
      <label>Verification token</label>
      <input type="text" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Zoom verification token for that channel" />
      <label>How to route</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label className="notif-check"><input type="radio" name={`nmode-${slug}`} checked={mode === "also"} onChange={() => setMode("also")} style={radioStyle} /> Send here <strong>and</strong> the global channel</label>
        <label className="notif-check"><input type="radio" name={`nmode-${slug}`} checked={mode === "only"} onChange={() => setMode("only")} style={radioStyle} /> Send here <strong>only</strong> (skip the global channel)</label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button className="primary" disabled={busy || !url.trim()} onClick={() => submit(false)}>Save</button>
        {has && <button disabled={busy} onClick={() => submit(true)}>Remove override</button>}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}
