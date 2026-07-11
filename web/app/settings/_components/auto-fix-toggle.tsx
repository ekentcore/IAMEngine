"use client";

// Opt-in toggle for the self-healing fix lane's auto-trigger ("autoFix" app setting). When on, a
// run-log failure that recurs ≥3 times unresolved is handed to headless Claude Code automatically
// (one per sweep). The output is always a DRAFT PR — a human still reviews and merges every fix.
import { useState } from "react";

export function AutoFixToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setSaving(true); setErr(null);
    try {
      const r = await fetch("/api/admin/auto-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(d.error ?? `failed (${r.status})`);
        return;
      }
      setEnabled(next);
    } catch {
      setErr("request failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>Self-healing fixes</h2>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        Operators can hand any failing run-log line to Claude Code from the <a href="/runs">Runs</a> page
        (🤖 Fix with Claude). It works in an isolated copy of the code and opens a <b>draft pull request</b> —
        nothing changes until a human reviews and merges it.
      </p>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
          style={{ width: "auto" }}
        />
        Automatically hand repeated failures to Claude
      </label>
      <p className="note" style={{ marginTop: 4 }}>
        When on: a failure that recurs 3+ times without being resolved is queued for a fix automatically
        (at most one new fix per sweep, and never twice for the same failure). This only <b>proposes</b> a
        fix — a human still reviews and merges the draft PR. Default off.
      </p>
      {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
    </section>
  );
}
