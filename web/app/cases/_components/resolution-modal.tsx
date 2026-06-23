"use client";

// Resolution review — a modal that previews EVERYTHING the case did (every step + what it changed,
// what was done by hand, and any follow-ups) — the exact work note that posts to ServiceNow. Opened
// from the case-resolution step once all other steps are done.
import { useEffect, useRef, useState } from "react";
import type { RunReport } from "@/lib/cases/run-report";
import { buildResolutionNote } from "@/lib/cases/resolution-note";

const ICON: Record<string, string> = {
  verified: "✓", warning: "⚠", failed: "✗", skipped: "–", manual: "✋",
  needs_approval: "⏸", pending: "…", running: "▶", verifying: "🔎",
};
const ICON_COLOR: Record<string, string> = {
  verified: "#15803d", warning: "#92400e", failed: "#b91c1c", manual: "#6b7280", skipped: "#9ca3af",
};

export function ResolutionModal({ report, caseId, writeEnabled, open, onClose }: { report: RunReport; caseId: string; writeEnabled: boolean; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const note = buildResolutionNote(report);

  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);

  const steps = report.steps.filter((s) => s.systemKey !== "case-resolution");
  const manualLeft = steps.filter((s) => s.verdict === "manual" && !s.manualCompleted);
  const attention = steps.filter((s) => s.verdict === "failed" || s.verdict === "warning");

  async function postWorkNote() {
    setBusy(true); setPosted(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/worknote`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      setPosted(res.ok ? "✓ Work note posted to ServiceNow" : `✗ ${j.error ?? `failed (${res.status})`}`);
    } catch (e) {
      setPosted(`✗ ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={ref} onClose={onClose} style={{ width: 720, maxWidth: "95vw" }}>
      <div className="row-between"><h2 style={{ margin: 0 }}>Resolution — ticket write-back</h2><button onClick={onClose}>Close</button></div>
      <p className="note" style={{ marginTop: 4 }}>
        Everything this {report.action} did. Review the steps and any manual follow-ups, then post it as a ServiceNow work note (or copy it).
      </p>

      {/* Structured per-step summary */}
      <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "0.5rem 0.7rem", margin: "0.6rem 0", display: "grid", gap: 5, maxHeight: 260, overflowY: "auto" }}>
        {steps.map((s) => {
          const acts = s.actions.filter((a) => !/^\s*WARN/i.test(a));
          const did = acts.join("; ") || (s.verdict === "manual" ? "completed by hand" : s.verdict === "skipped" ? "not applicable" : s.verdict);
          return (
            <div key={s.seq} style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "baseline" }}>
              <span style={{ width: 14, color: ICON_COLOR[s.verdict] ?? "#6b7280" }}>{ICON[s.verdict] ?? "•"}</span>
              <b style={{ minWidth: 140 }}>{s.systemName}</b>
              <span className="muted" style={{ flex: 1, whiteSpace: "normal" }}>{did}</span>
            </div>
          );
        })}
        {steps.length === 0 && <span className="muted">No steps.</span>}
      </div>

      {manualLeft.length > 0 && (
        <p className="note" style={{ color: "#92400e", margin: "0 0 0.3rem" }}>
          ✋ Confirm done by hand: <b>{manualLeft.map((m) => m.systemName).join(", ")}</b> (mark them complete on the case before resolving).
        </p>
      )}
      {attention.length > 0 && (
        <p className="note" style={{ color: "#b45309", margin: "0 0 0.3rem" }}>
          ⚠ Review before resolving: <b>{attention.map((a) => a.systemName).join(", ")}</b>
        </p>
      )}

      <label className="note" style={{ display: "block", marginTop: 8, fontWeight: 600 }}>Work note text (what gets posted)</label>
      <textarea readOnly value={note} rows={10} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />

      {posted && <p className="note" style={{ color: posted.startsWith("✓") ? "#15803d" : "#b91c1c", marginTop: 6 }}>{posted}</p>}

      <div className="dialog-actions">
        <button onClick={() => { navigator.clipboard?.writeText(note); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied ✓" : "Copy"}</button>
        <button
          className="primary"
          disabled={!writeEnabled || busy}
          title={writeEnabled ? "Post this as a work note on the ServiceNow case" : "ServiceNow write-back is disabled (read-only key) — copy the text instead"}
          onClick={postWorkNote}
        >
          {busy ? "Posting…" : "Post work note to ServiceNow"}
        </button>
      </div>
    </dialog>
  );
}
