"use client";

// Auto-update stale agents on heartbeat (the "agent_auto_update" app setting, default ON). When on,
// any enabled runner reporting a build older than the one the app serves is told to self-update on
// its next heartbeat — so restarting the app (new bundle) rolls the whole fleet forward without
// clicking Update on each agent. Off = agents only update when an operator asks.
import { useState } from "react";

export function AgentAutoUpdateToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setSaving(true); setErr(null);
    try {
      const r = await fetch("/api/admin/agent-auto-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) { const d = (await r.json().catch(() => ({}))) as { error?: string }; setErr(d.error ?? `failed (${r.status})`); return; }
      setEnabled(next);
    } catch { setErr("request failed"); } finally { setSaving(false); }
  }

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>Agent auto-update</h2>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        Keep runners on the build the app serves. When on, any agent reporting an older build is told to
        self-update on its next check-in — so restarting the app rolls the fleet forward automatically.
        Each update is the runner&rsquo;s own safe re-exec at a quiet point; a mid-job agent finishes first.
      </p>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => toggle(e.target.checked)} style={{ width: "auto" }} />
        Automatically update out-of-date agents
      </label>
      {err && <p className="note danger" style={{ marginTop: 6 }}>{err}</p>}
    </section>
  );
}
