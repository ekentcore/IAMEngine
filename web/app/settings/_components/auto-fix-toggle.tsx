"use client";

// Opt-in toggle for the self-healing fix lane's auto-trigger ("autoFix" app setting). When on, a
// run-log failure that recurs ≥3 times unresolved is handed to the default LLM provider
// automatically (one per sweep). The output is a PROPOSAL an operator reviews on /runs — and the
// eventual PR is always a draft a human merges.
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
        Operators can hand any failing run-log line to the default LLM provider from the <a href="/runs">Runs</a> page
        (🤖 Fix with AI). It reads the code and proposes an exact fix — file, lines, before/after — which you
        review on screen; applying it opens a <b>draft pull request</b>. Nothing changes until a human merges.
      </p>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
          style={{ width: "auto" }}
        />
        Automatically hand repeated failures to the default LLM provider
      </label>
      <p className="note" style={{ marginTop: 4 }}>
        When on: a failure that recurs 3+ times without being resolved is queued for analysis automatically
        (at most one new task per sweep, and never twice for the same failure). This only <b>proposes</b> a
        fix — an operator reviews it on the Runs page and a human still merges the draft PR. Default off.
      </p>
      {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
    </section>
  );
}
