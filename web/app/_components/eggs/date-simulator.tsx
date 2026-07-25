"use client";

// Super-admin 📅 button (left of the 💡): pick a date and the app's EASTER EGGS act as if it's
// that date — nothing else does. Cookie-based (ThemeToggle pattern), session-scoped, and the
// server honors it only for a real super_admin (fail-closed). The strip makes the state obvious.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTypedWord } from "./use-typed-word";

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
        onClick={() => { setValue(current ?? ""); setOpen(true); }}
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
                aria-label="Simulated date"
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

const CIRCUIT_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const CIRCUIT_MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

// One LED row of the DeLorean time circuits: label + MON / DAY / YEAR segments in the row's color.
// Exported for the /easter-eggs demo modal, which stages the circuits without a live simulation.
export function CircuitRow({ label, date, color }: { label: string; date: string; color: string }) {
  const [y, m, d] = date.split("-");
  const seg: React.CSSProperties = {
    background: "#000", color, fontFamily: CIRCUIT_MONO, padding: "1px 7px", borderRadius: 3,
    textShadow: `0 0 7px ${color}`, fontSize: 13, letterSpacing: "0.12em", fontWeight: 700,
  };
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "#d6d3d1" }}>{label}</span>
      <span style={seg}>{CIRCUIT_MONTHS[Number(m) - 1] ?? "???"}</span>
      <span style={seg}>{d ?? "??"}</span>
      <span style={seg}>{y ?? "????"}</span>
    </span>
  );
}

export function SimulatedDateStrip({ date, realDate }: { date: string; realDate: string }) {
  const router = useRouter();
  // Easter egg: typing "bttf" while simulating turns the strip into DeLorean time circuits —
  // DESTINATION TIME (simulated, red) vs PRESENT TIME (real, green) — behind a flux-capacitor
  // flash. Doubles as a can't-miss reminder that you're in simulated time. Esc/retype reverts.
  const [bttf] = useTypedWord("bttf");
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!bttf || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 650);
    return () => { clearTimeout(t); setFlash(false); };
  }, [bttf]);

  const resetBtn = (dark: boolean) => (
    <button
      type="button"
      style={{ fontSize: 12, padding: "0.15rem 0.6rem", background: dark ? "#d6d3d1" : "#fff", color: dark ? "#1c1917" : "#4c1d95", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
      onClick={() => { setSimCookie(null); router.refresh(); }}
    >
      Reset
    </button>
  );

  if (bttf) {
    return (
      <div style={{ background: "linear-gradient(180deg, #292524, #1c1917)", borderBottom: "1px solid #44403c", padding: "0.4rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ fontSize: 14 }} aria-hidden>⚡</span>
        <CircuitRow label="DESTINATION TIME" date={date} color="#ff3b30" />
        <CircuitRow label="PRESENT TIME" date={realDate} color="#34d399" />
        <CircuitRow label="LAST TIME DEPARTED" date={realDate} color="#fbbf24" />
        <span style={{ color: "#a8a29e", fontFamily: CIRCUIT_MONO, fontSize: 10, letterSpacing: "0.1em" }}>88 MPH — Esc to return to 1985</span>
        {resetBtn(true)}
        {flash && createPortal(
          <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none", background: "#fff", animation: "egg-flux-flash 0.65s ease-out forwards" }}>
            <style>{`@keyframes egg-flux-flash { from { opacity: 1 } to { opacity: 0 } }`}</style>
          </div>,
          document.body
        )}
      </div>
    );
  }

  return (
    <div style={{ background: "#4c1d95", color: "#fff", padding: "0.35rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 12 }}>
      <span>📅 Simulated date: <strong>{date}</strong> — easter-egg preview only</span>
      {resetBtn(false)}
    </div>
  );
}
