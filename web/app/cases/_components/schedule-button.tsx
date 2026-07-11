"use client";

// Schedule a case to start at a date+time: sets CaseRequest.scheduledFor (holding the case if it
// isn't already held); the runner-heartbeat sweep auto-resumes it when the time arrives. The picker
// is prefilled with the server-computed default (offboard date + 5 min / onboard start − 3 business
// days, falling back to ~now+1h).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { formatDateTime } from "@/lib/dates";
import { defaultScheduleFor } from "@/lib/cases/schedule";

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 };
const cardStyle: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", maxWidth: 460, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" };

// Portal to <body> so the fixed overlay centers in the viewport (same pattern as the password
// dialogs — an inline fixed overlay can be positioned by a transformed ancestor).
function Overlay({ onBackdropClick, children }: { onBackdropClick?: () => void; children: React.ReactNode }) {
  return createPortal(
    <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onBackdropClick?.(); }}>
      <div style={cardStyle}>{children}</div>
    </div>,
    document.body
  );
}

// A Date/ISO as the wall-clock string <input type="datetime-local"> wants ("2026-07-20T17:05").
function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ScheduleButton({ caseId, action, scheduledForIso, effectiveDate }: {
  caseId: string;
  action: string;
  scheduledForIso: string | null;
  // The case's effective date string; the default time is computed from it HERE, in the browser, so
  // "08:00" / "+5 min" resolve in the operator's timezone rather than the server's.
  effectiveDate: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post(at: string | null) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/cases/${caseId}/schedule`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ at }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      setOpen(false);
      router.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const openPicker = () => {
    setErr(null);
    // Prefill: the current schedule if set, else the suggested default computed in the browser
    // (offboard date + 5 min / onboard start − 3 business days), falling back to ~an hour from now.
    const now = new Date();
    const suggested = scheduledForIso
      ? new Date(scheduledForIso)
      : defaultScheduleFor(action === "offboard" ? "offboard" : "onboard", effectiveDate, now) ?? new Date(now.getTime() + 3600_000);
    setValue(toLocalInputValue(suggested));
    setOpen(true);
  };

  return (
    <>
      {scheduledForIso ? (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center", whiteSpace: "nowrap" }}>
          <button disabled={busy} style={{ color: "#8a6d00" }} title="Scheduled to start automatically at this time — click to change" onClick={openPicker}>
            ⏰ scheduled {formatDateTime(scheduledForIso)}
          </button>
          <button disabled={busy} className="note" title="Clear the schedule — the case stays held until you resume it" onClick={() => void post(null)}>
            clear
          </button>
        </span>
      ) : (
        <button disabled={busy} title="Hold the case until a date+time, then start it automatically" onClick={openPicker}>
          ⏰ Schedule…
        </button>
      )}
      {open && (
        <Overlay onBackdropClick={() => setOpen(false)}>
          <h2 style={{ margin: "0 0 0.25rem" }}>Schedule case start</h2>
          <p className="note" style={{ marginTop: 0 }}>
            The case stays paused until this time, then resumes automatically and runners begin its steps.
            {action === "offboard" ? " Suggested: the offboarding date + 5 minutes." : " Suggested: 3 business days before the start date, 8:00 AM."}
          </p>
          <input
            type="datetime-local"
            value={value}
            min={toLocalInputValue(new Date())}
            onChange={(e) => setValue(e.target.value)}
            style={{ padding: "0.35rem 0.5rem", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "inherit" }}
          />
          {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
          <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8, marginTop: "0.8rem" }}>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button
              className="primary"
              disabled={busy || !value}
              onClick={() => {
                const at = new Date(value);
                if (Number.isNaN(at.getTime())) { setErr("enter a valid date and time"); return; }
                void post(at.toISOString());
              }}
            >
              {busy ? "Saving…" : "Schedule"}
            </button>
          </div>
        </Overlay>
      )}
    </>
  );
}
