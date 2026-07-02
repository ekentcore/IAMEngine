"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NOTIF_CHANNELS, type ClientNotifyOverride as Override, type NotifChannel } from "@/lib/notifications/types";

const radioStyle = { width: "auto", margin: 0, flex: "none" as const };

// Per-client notification override, on the client detail page. For each channel: this client's own
// destination + a mode — "also" (client dest PLUS the global default/restricted base) or "only"
// (client dest alone). Blank a channel to not override it. Server drops empty channels.
export function ClientNotifyOverride({ slug, initial }: { slug: string; initial: Override }) {
  const router = useRouter();
  const [ov, setOv] = useState<Override>(initial);
  const [emailRaw, setEmailRaw] = useState(initial.email?.recipients?.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const setChan = (ch: NotifChannel, patch: Record<string, unknown>) =>
    setOv((prev) => ({ ...prev, [ch]: { mode: "also", ...(prev[ch] ?? {}), ...patch } }));

  async function submit(clearAll: boolean) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-notify-override", override: clearAll ? null : ov }),
      });
      if (!res.ok) { setMsg((await res.json().catch(() => ({}))).error ?? "Could not save."); return; }
      if (clearAll) { setOv({}); setEmailRaw(""); setMsg("Cleared — this client uses the global routing."); }
      else setMsg("Saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const hasAny = Object.keys(ov).length > 0;

  return (
    <div style={{ maxWidth: 600 }}>
      <p className="note">
        By default this client&rsquo;s failure alerts follow the global routing (default vs restricted). Override any
        channel here to send to <strong>this client&rsquo;s own</strong> destination — leave a channel blank to keep the global one.
      </p>
      {NOTIF_CHANNELS.map((c) => {
        const o = ov[c.key];
        const isEmail = c.kind === "email";
        return (
          <div className="notif-dest" key={c.key}>
            <div style={{ fontWeight: 600 }}>{c.label}</div>
            {isEmail ? (
              <input type="text" placeholder="recipients (comma-separated) — blank = don't override" value={emailRaw}
                onChange={(e) => { setEmailRaw(e.target.value); setChan("email", { recipients: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); }} />
            ) : (
              <input type="url" placeholder="this client's webhook URL — blank = don't override" value={o?.webhookUrl ?? ""}
                onChange={(e) => setChan(c.key, { webhookUrl: e.target.value })} />
            )}
            {c.kind === "zoom" && (
              <input type="text" placeholder="Zoom verification token" value={o?.token ?? ""} onChange={(e) => setChan("zoom", { token: e.target.value })} />
            )}
            <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
              <label className="notif-check"><input type="radio" name={`m-${slug}-${c.key}`} checked={(o?.mode ?? "also") === "also"} onChange={() => setChan(c.key, { mode: "also" })} style={radioStyle} /> also the global channel</label>
              <label className="notif-check"><input type="radio" name={`m-${slug}-${c.key}`} checked={o?.mode === "only"} onChange={() => setChan(c.key, { mode: "only" })} style={radioStyle} /> only here</label>
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button className="primary" disabled={busy} onClick={() => submit(false)}>Save</button>
        {hasAny && <button disabled={busy} onClick={() => submit(true)}>Clear all overrides</button>}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}
