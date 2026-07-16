"use client";

// Reveal the new hire's generated initial password EXACTLY ONCE (a "generate"-mode onboard). The value
// is wiped server-side on reveal, so this shows it in a popup with a save-now warning and won't return
// it again. Only rendered when a password is pending.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/app/_components/copy-button";

export function RevealPasswordButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [pw, setPw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reveal() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/reveal-password`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      setPw(d.password);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  if (pw) {
    // Portal to <body>: rendered inline, the fixed overlay can be positioned by a transformed/contained
    // ancestor and land far down the page instead of centered in the viewport (INC0855142 follow-up).
    return createPortal(
      <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 }}
        onClick={(e) => { if (e.target === e.currentTarget) { setPw(null); router.refresh(); } }}>
        <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", maxWidth: 420, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" }}>
          <h2 style={{ margin: "0 0 0.25rem" }}>Initial password</h2>
          <p className="note" style={{ color: "#b3261e", marginTop: 0 }}>⚠ Shown once. Save it now — it can&rsquo;t be shown again. Give it to the new hire; they&rsquo;ll be prompted to change it at first sign-in.</p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0.6rem 0" }}>
            <code style={{ fontSize: 16, padding: "0.35rem 0.6rem", border: "1px solid var(--line)", borderRadius: 6, userSelect: "all" }}>{pw}</code>
            {/* This password is shown ONCE and wiped on "I saved it". The old button was
                `navigator.clipboard?.writeText(pw)` — on the LAN URL that is a silent no-op, so it
                did nothing, said nothing, and the next click destroyed the only copy. A copy button
                here must never imply success it didn't get. */}
            <CopyButton text={pw} label="Copy" copiedLabel="Copied ✓" style={{ fontSize: 13, padding: "0.3rem 0.7rem" }} />
          </div>
          <div className="toolbar" style={{ justifyContent: "flex-end" }}>
            <button className="primary" onClick={() => { setPw(null); router.refresh(); }}>I saved it</button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button onClick={reveal} disabled={busy} title="Show the generated initial password once, then it's wiped">
        {busy ? "Revealing…" : "🔑 Reveal initial password"}
      </button>
      {err && <span className="note" style={{ color: "#b3261e" }}>{err}</span>}
    </span>
  );
}
