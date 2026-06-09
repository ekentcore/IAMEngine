"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunReport, StepVerdict } from "@/lib/cases/run-report";

const VERDICT: Record<StepVerdict, { label: string; color: string }> = {
  verified: { label: "verified", color: "#15803d" },
  warning: { label: "warning", color: "#b45309" },
  failed: { label: "failed", color: "#b91c1c" },
  skipped: { label: "skipped", color: "#6b7280" },
  manual: { label: "manual", color: "#374151" },
  needs_approval: { label: "needs approval", color: "#7c3aed" },
  pending: { label: "pending", color: "#6b7280" },
};

const PRE: React.CSSProperties = {
  background: "#f6f8fa", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0.6rem",
  overflowX: "auto", fontSize: 11, lineHeight: 1.45, margin: "0.25rem 0 0",
};

function Badge({ verdict }: { verdict: StepVerdict }) {
  const v = VERDICT[verdict];
  return <span className="badge" style={{ color: v.color, borderColor: v.color }}>{v.label}</span>;
}

// The after-action run report: per-step verdicts, actions, validation read-backs, and errors.
// Auto-refreshes while the case is still running; offers per-step re-run + a gated SN write-back.
export function RunReportView({ initial, caseId, writeEnabled }: { initial: RunReport; caseId: string; writeEnabled: boolean }) {
  const [report, setReport] = useState<RunReport>(initial);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [writeBack, setWriteBack] = useState(false);
  const [writeMsg, setWriteMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/report`, { cache: "no-store" });
    if (res.ok) setReport((await res.json()) as RunReport);
  }, [caseId]);

  // Poll while the case is in flight (queued/planning/running) so the report tracks execution.
  // Poll faster (2s) when a step is actively executing so the live phase feels real-time.
  const live = ["queued", "planning", "running"].includes(report.caseStatus);
  const active = report.steps.some((s) => s.currentPhase);
  useEffect(() => {
    if (!live) { if (timer.current) clearInterval(timer.current); return; }
    timer.current = setInterval(refresh, active ? 2000 : 4000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [live, active, refresh]);

  const toggle = (n: number) => setOpen((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });

  // Auto-expand any step that's actively running so its live progress is visible without a click.
  // Once opened it stays open (we never auto-collapse) so the operator keeps the context.
  useEffect(() => {
    const running = report.steps.filter((s) => s.currentPhase).map((s) => s.seq);
    if (running.length) setOpen((prev) => { const x = new Set(prev); running.forEach((n) => x.add(n)); return x; });
  }, [report]);

  async function rerun(stepSeq: number, jobId: string | undefined) {
    if (!jobId) return;
    setBusy(`rerun-${stepSeq}`);
    setOpen((s) => new Set(s).add(stepSeq)); // expand immediately so the operator sees it start
    try {
      await fetch(`/api/jobs/${jobId}/rerun`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function markComplete(stepSeq: number, jobId: string | undefined, done: boolean) {
    if (!jobId) return;
    setBusy(`complete-${stepSeq}`);
    try {
      await fetch(`/api/jobs/${jobId}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }) });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function verifyAll() {
    setBusy("verify");
    try {
      await fetch(`/api/cases/${caseId}/verify`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function postWorkNote() {
    setBusy("worknote");
    setWriteMsg(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/worknote`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      setWriteMsg(res.ok ? "Work note posted to the UM ticket." : body.error ?? "Write-back failed.");
    } catch (e) {
      setWriteMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const s = report.summary;
  // Verification banner: the case auto-runs a read-only validation sweep once the automated work
  // finishes (and the operator can re-run it). Show whether the account has been verified.
  const verifying = active && !report.verifiedAt;
  // The step executing right now (for a prominent "what's happening" banner) — easier to follow than
  // scanning the per-step trails.
  const running = report.steps.find((st) => st.currentPhase);
  const pendingCount = report.steps.filter((st) => st.verdict === "pending" || st.verdict === "needs_approval").length;
  // Pull the cross-lane mirror-coverage check (from the m365 validator) up to the banner so the
  // person handling the case sees mirror completeness without expanding a step.
  const mirrorCheck = report.steps.flatMap((st) => st.validation?.checks ?? []).find((c) => /mirror coverage/i.test(c.name));
  return (
    <div>
      <style>{`@keyframes pulse { 0%,100% { opacity: 0.35 } 50% { opacity: 1 } }`}</style>
      {running && (
        <div style={{ margin: "0 0 0.5rem", padding: "0.5rem 0.7rem", borderRadius: 4, fontSize: 13, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ animation: "pulse 1.1s ease-in-out infinite", fontSize: 16 }}>▶</span>
          <span><b>{running.systemName}</b> — {running.currentPhase}…{pendingCount > 1 ? ` (${pendingCount} steps remaining)` : ""}</span>
        </div>
      )}
      {(report.verifiedAt || verifying) && (
        <div style={{ margin: "0 0 0.5rem", padding: "0.45rem 0.6rem", borderRadius: 4, fontSize: 13, border: "1px solid", borderColor: report.verifiedAt ? "#bbf7d0" : "#bfdbfe", background: report.verifiedAt ? "#f0fdf4" : "#eff6ff", color: report.verifiedAt ? "#15803d" : "#1d4ed8" }}>
          <div>
            {report.verifiedAt
              ? <>🔎 Account verified {new Date(report.verifiedAt).toLocaleString()} — {s.failed > 0 || s.warnings > 0 ? `${s.failed} failed, ${s.warnings} warning to review before resolving` : "all checks passed; safe to resolve the case"}</>
              : <><span style={{ display: "inline-block", animation: "pulse 1.2s ease-in-out infinite" }}>🔎</span> Verifying the account — re-checking accounts, licensing, mirroring & access…</>}
          </div>
          {mirrorCheck && (
            <div style={{ marginTop: 4, fontWeight: 600, color: mirrorCheck.pass ? "#15803d" : "#b45309" }}>
              👥 {mirrorCheck.pass ? "✓" : "⚠"} {mirrorCheck.name}
            </div>
          )}
        </div>
      )}
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <p className="note" style={{ margin: 0 }}>
          {s.succeeded} verified · {s.warnings} warning · {s.failed} failed · {s.skipped} skipped · {s.manual} manual
          {s.needsApproval > 0 && ` · ${s.needsApproval} needs approval`}
          {s.pending > 0 && ` · ${s.pending} pending`}
          {live && <span className="muted"> · refreshing…</span>}
        </p>
        <div className="toolbar">
          <button onClick={() => setOpen(new Set(report.steps.map((st) => st.seq)))} title="Expand every step">Expand all</button>
          <button onClick={() => setOpen(new Set())} title="Collapse every step">Collapse all</button>
          <button onClick={verifyAll} disabled={busy === "verify"} title="Re-run every step's read-only validation to confirm the whole account is correct — no changes are made">
            {busy === "verify" ? "verifying…" : "✓ Verify everything"}
          </button>
          <button onClick={refresh}>Refresh</button>
          <a href={`/api/cases/${caseId}/report?format=md`} download className="note">download .md →</a>
        </div>
      </div>

      {report.steps.map((step) => {
        const isOpen = open.has(step.seq);
        const hasDetail = step.actions.length > 0 || step.validation || step.error || step.phaseTrail.length > 0;
        return (
          <details key={step.seq} open={isOpen} style={{ margin: "0.2rem 0" }}>
            <summary onClick={(e) => { e.preventDefault(); if (hasDetail) toggle(step.seq); }} style={{ cursor: hasDetail ? "pointer" : "default" }}>
              <strong style={{ marginRight: 6 }}>{step.seq}.</strong>
              <Badge verdict={step.verdict} /> {step.systemName} <span className="note">({step.systemKey})</span>
              {step.currentPhase && (
                <span style={{ marginLeft: 8, color: "#2563eb", fontSize: 12 }}>
                  <span style={{ display: "inline-block", animation: "pulse 1.2s ease-in-out infinite" }}>▸</span> {step.currentPhase}…
                </span>
              )}
              {/* Any finished automated step can be re-run — incl. "verified" (e.g. re-run exchange to
                  finish regional/calendar deferred when the mailbox hadn't synced yet). */}
              {["verified", "warning", "failed", "skipped"].includes(step.verdict) && step.jobId && (
                <button
                  style={{ marginLeft: 8, fontSize: 11 }}
                  disabled={busy === `rerun-${step.seq}`}
                  onClick={(e) => { e.preventDefault(); rerun(step.seq, step.jobId); }}
                >
                  {busy === `rerun-${step.seq}` ? "re-running…" : "re-run / re-validate"}
                </button>
              )}
              {/* Manual / skipped steps an operator does by hand — mark them done so the case can
                  reach "completed"; unmark if it was closed by mistake. */}
              {(step.verdict === "manual" || step.verdict === "skipped") && step.jobId && (
                <button
                  style={{ marginLeft: 8, fontSize: 11 }}
                  disabled={busy === `complete-${step.seq}`}
                  onClick={(e) => { e.preventDefault(); markComplete(step.seq, step.jobId, true); }}
                >
                  {busy === `complete-${step.seq}` ? "marking…" : "✓ mark complete"}
                </button>
              )}
              {step.manualCompleted && step.jobId && (
                <>
                  <span style={{ marginLeft: 8, fontSize: 11, color: "#15803d" }}>done by hand</span>
                  <button
                    style={{ marginLeft: 6, fontSize: 11 }}
                    disabled={busy === `complete-${step.seq}`}
                    onClick={(e) => { e.preventDefault(); markComplete(step.seq, step.jobId, false); }}
                  >
                    {busy === `complete-${step.seq}` ? "…" : "unmark"}
                  </button>
                </>
              )}
            </summary>
            <div style={{ margin: "0.4rem 0 0.6rem 0.8rem" }}>
              {step.actions.length > 0 && (
                <div>
                  <div className="note">Actions:</div>
                  <ul className="muted" style={{ margin: "0.2rem 0 0" }}>
                    {step.actions.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                </div>
              )}
              {step.validation && (
                <div style={{ marginTop: "0.4rem" }}>
                  <div className="note">Validation: {step.validation.ok ? "ok" : "MISS"}</div>
                  <ul className="muted" style={{ margin: "0.2rem 0 0" }}>
                    {step.validation.checks.map((c, i) => (
                      <li key={i} style={{ color: c.pass ? undefined : "#b91c1c" }}>
                        {c.pass ? "✓" : "✗"} {c.name}
                        {c.expected !== undefined && ` (expected ${String(c.expected)}, got ${String(c.actual)})`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {step.error && <pre style={{ ...PRE, color: "#b91c1c" }}>{step.error}</pre>}
              {step.phaseTrail.length > 0 && (
                <div style={{ marginTop: "0.4rem" }}>
                  <div className="note">Progress:</div>
                  <ul className="muted" style={{ margin: "0.2rem 0 0", listStyle: "none", paddingLeft: 0 }}>
                    {step.phaseTrail.map((p, i) => (
                      <li key={i}>
                        <span style={{ color: "#9ca3af", marginRight: 6 }}>{p.ts ? new Date(p.ts).toLocaleTimeString() : ""}</span>
                        {p.phase}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        );
      })}

      <div style={{ marginTop: "0.8rem", paddingTop: "0.6rem", borderTop: "1px solid #e5e7eb" }}>
        <label className="note" title={writeEnabled ? undefined : "Disabled — the ServiceNow key is read-only (SN_WRITE_ENABLED is off)"}>
          <input type="checkbox" checked={writeBack} disabled={!writeEnabled} onChange={(e) => setWriteBack(e.target.checked)} style={{ marginRight: 6 }} />
          Write back to UM
        </label>
        <button
          style={{ marginLeft: 8 }}
          disabled={!writeEnabled || !writeBack || busy === "worknote"}
          onClick={postWorkNote}
        >
          {busy === "worknote" ? "posting…" : "Post work note"}
        </button>
        {writeMsg && <span className="note" style={{ marginLeft: 8 }}>{writeMsg}</span>}
      </div>
    </div>
  );
}
