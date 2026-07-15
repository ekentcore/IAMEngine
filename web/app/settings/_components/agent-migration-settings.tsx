"use client";

// Agent app-URL migration (the "agent_migration" app setting). Point agents at a new app hostname:
// set the target, prove it on one agent with the Agents-page Migrate button, then enable it fleet-wide.
// Each agent verifies it can reach the new URL, rewrites its own supervisor entry, and switches — the
// old URL is removed once it reports in on the new one.
import { useState } from "react";

export function AgentMigrationSettings({ initial }: { initial: { enabled: boolean; targetUrl: string } }) {
  const [targetUrl, setTargetUrl] = useState(initial.targetUrl);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(next: { enabled: boolean; targetUrl: string }) {
    setSaving(true); setErr(null); setOk(false);
    try {
      const r = await fetch("/api/admin/agent-migration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!r.ok) { const d = (await r.json().catch(() => ({}))) as { error?: string }; setErr(d.error ?? `failed (${r.status})`); return; }
      setEnabled(next.enabled); setTargetUrl(next.targetUrl); setOk(true);
    } catch { setErr("request failed"); } finally { setSaving(false); }
  }

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>Agent domain migration</h2>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        Move agents to a new app URL. Set the target below, prove it on one agent with the{" "}
        <strong>Migrate</strong> button on the <a href="/agents">Agents</a> page, then enable it fleet-wide.
        Each agent verifies it can reach the new URL, rewrites its own scheduled task, and switches — the
        old URL is removed once it reports in on the new one. Keep the old host up until every agent shows
        &ldquo;migrated&rdquo;.
      </p>
      <label style={{ display: "block", fontSize: 14, marginBottom: 8 }}>
        New app base URL
        <input
          type="url"
          placeholder="https://iam.core.tech"
          value={targetUrl}
          disabled={saving}
          onChange={(e) => setTargetUrl(e.target.value)}
          style={{ display: "block", marginTop: 4, width: "100%", maxWidth: 420 }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button disabled={saving} onClick={() => save({ enabled, targetUrl })}>{saving ? "Saving…" : "Save target"}</button>
        <button disabled={saving || !targetUrl} onClick={() => save({ enabled: !enabled, targetUrl })}>
          {enabled ? "Disable fleet migration" : "Enable fleet migration"}
        </button>
      </div>
      <p className="note" style={{ marginTop: 6 }}>
        Fleet migration: {enabled ? "ON — every agent migrates on its next heartbeat" : "off — only agents you migrate individually"}
      </p>
      {err && <p className="note danger" style={{ marginTop: 6 }}>{err}</p>}
      {ok && <p className="note" style={{ marginTop: 6, color: "var(--ok, #070)" }}>saved</p>}
    </section>
  );
}
