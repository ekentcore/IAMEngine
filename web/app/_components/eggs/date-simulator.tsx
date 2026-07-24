"use client";

// Super-admin 📅 button (left of the 💡): pick a date and the app's EASTER EGGS act as if it's
// that date — nothing else does. Cookie-based (ThemeToggle pattern), session-scoped, and the
// server honors it only for a real super_admin (fail-closed). The strip makes the state obvious.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 };
const cardStyle: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", width: "min(380px, calc(100vw - 2rem))", boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" };

function setSimCookie(value: string | null) {
  document.cookie = value
    ? `simulated_date=${value}; path=/; samesite=lax`
    : "simulated_date=; path=/; max-age=0; samesite=lax";
}

export function DateSimulatorButton({ current }: { current?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");

  function apply() {
    if (value) setSimCookie(value);
    setOpen(false);
    router.refresh();
  }
  function reset() {
    setSimCookie(null);
    setValue("");
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        title="Simulate a date (easter-egg preview)"
        aria-label="Simulate a date"
        onClick={() => setOpen(true)}
        style={{ padding: "0.15rem 0.4rem", fontSize: 14, lineHeight: 1 }}
      >
        📅
      </button>
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
            <div style={cardStyle}>
              <h2 style={{ margin: "0 0 0.25rem" }}>Simulate a date</h2>
              <p className="note" style={{ marginTop: 0 }}>
                The app&rsquo;s easter eggs will act as if it&rsquo;s this date. Nothing else changes — cases, jobs, and audit all keep real time.
              </p>
              <input
                type="date"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={{ width: "100%", marginBottom: "0.8rem" }}
                autoFocus
              />
              <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setOpen(false)}>Cancel</button>
                {current && <button onClick={reset}>Reset to today</button>}
                <button className="primary" disabled={!value} onClick={apply}>Apply</button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export function SimulatedDateStrip({ date }: { date: string }) {
  const router = useRouter();
  return (
    <div style={{ background: "#4c1d95", color: "#fff", padding: "0.35rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 12 }}>
      <span>📅 Simulated date: <strong>{date}</strong> — easter-egg preview only</span>
      <button
        type="button"
        style={{ fontSize: 12, padding: "0.15rem 0.6rem", background: "#fff", color: "#4c1d95", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
        onClick={() => { setSimCookie(null); router.refresh(); }}
      >
        Reset
      </button>
    </div>
  );
}
