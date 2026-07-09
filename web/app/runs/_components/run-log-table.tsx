"use client";

// The run-log table with multi-select: tick the open errors/warnings and Fix them in one go. Rows are
// computed server-side (page.tsx) and passed in as a serializable VM. Per-row Copy/Fix still work.
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "./copy-button";
import { FixButton } from "./fix-button";
import { resolveManyOutcomes } from "../actions";

export type RunLogRow = {
  id: string;
  atLabel: string;
  count: number;
  caseRequestId: string;
  caseNumber: string;
  action: string;
  clientName: string;
  systemKey: string;
  validateOnly: boolean;
  verdict: string;
  messages: string[];
  done: boolean; // resolved (Fixed)
  resolvedBy: string | null;
  fingerprint: string;
  copyText: string;
};

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  failed: { bg: "var(--err-bg)", fg: "var(--err-fg)", label: "✗ error" },
  warning: { bg: "var(--warn-bg)", fg: "var(--warn-fg)", label: "⚠ warning" },
  verified: { bg: "var(--ok-bg)", fg: "var(--ok-fg)", label: "✓ success" },
  skipped: { bg: "var(--neutral-bg)", fg: "var(--neutral-fg)", label: "skipped" },
  manual: { bg: "var(--info-bg)", fg: "var(--info-fg)", label: "✋ manual" },
  pending: { bg: "var(--neutral-bg)", fg: "var(--neutral-fg)", label: "pending" },
};

function Badge({ verdict }: { verdict: string }) {
  const s = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.pending;
  return <span style={{ background: s.bg, color: s.fg, borderRadius: 6, padding: "1px 7px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{s.label}</span>;
}

// Only OPEN errors/warnings can be Fixed — those are the selectable rows.
const isFixable = (r: RunLogRow) => !r.done && (r.verdict === "warning" || r.verdict === "failed") && !!r.fingerprint;

export function RunLogTable({ rows, emptyText }: { rows: RunLogRow[]; emptyText: string }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set()); // selected fingerprints
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const fixableFps = useMemo(() => [...new Set(rows.filter(isFixable).map((r) => r.fingerprint))], [rows]);
  const allSelected = fixableFps.length > 0 && fixableFps.every((f) => sel.has(f));
  const toggle = (fp: string) => setSel((s) => { const x = new Set(s); x.has(fp) ? x.delete(fp) : x.add(fp); return x; });
  const toggleAll = () => setSel((s) => (allSelected ? new Set() : new Set(fixableFps)));

  function fixSelected() {
    setErr(null);
    start(async () => {
      const res = await resolveManyOutcomes([...sel]);
      if (!res.ok) { setErr(res.error); return; }
      setSel(new Set());
      router.refresh();
    });
  }

  return (
    <>
      {sel.size > 0 && (
        <div className="toolbar" style={{ alignItems: "center", gap: 8, margin: "0.4rem 0" }}>
          <b>{sel.size} selected</b>
          <button type="button" disabled={pending} onClick={fixSelected} style={{ color: "#111827", fontWeight: 600 }}>
            {pending ? "Fixing…" : `✓ Fix ${sel.size} selected`}
          </button>
          <button type="button" onClick={() => setSel(new Set())}>Clear</button>
          {err && <span className="note danger">{err}</span>}
        </div>
      )}

      {/* Fixed layout + explicit column widths so a long, unbreakable message (URLs, snake_case tokens)
          wraps inside the Message column instead of widening the table and pushing the actions off-card. */}
      <table style={{ width: "100%", tableLayout: "fixed", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line, #e5e7eb)" }}>
            <th style={{ padding: "4px 8px", width: 28 }}>
              <input type="checkbox" aria-label="Select all fixable" checked={allSelected} disabled={fixableFps.length === 0}
                ref={(el) => { if (el) el.indeterminate = sel.size > 0 && !allSelected; }} onChange={toggleAll} />
            </th>
            <th style={{ padding: "4px 8px", width: 120 }}>When</th>
            <th style={{ padding: "4px 8px", width: 100 }}>Case</th>
            <th style={{ padding: "4px 8px", width: 150 }}>Client</th>
            <th style={{ padding: "4px 8px", width: 116 }}>Module</th>
            <th style={{ padding: "4px 8px", width: 78 }}>Result</th>
            <th style={{ padding: "4px 8px" }}>Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const fixable = isFixable(r);
            return (
              <tr key={r.id} style={{ borderBottom: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top", opacity: r.done ? 0.5 : 1, background: sel.has(r.fingerprint) ? "#eff6ff" : undefined }}>
                <td style={{ padding: "4px 8px" }}>
                  {fixable && <input type="checkbox" aria-label="Select line" checked={sel.has(r.fingerprint)} onChange={() => toggle(r.fingerprint)} />}
                </td>
                <td style={{ padding: "4px 8px", color: "var(--muted, #6b7280)" }}>
                  <span style={{ whiteSpace: "nowrap" }}>{r.atLabel}</span>
                  {r.count > 1 && <span className="note" style={{ display: "block" }}>×{r.count}</span>}
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <Link href={`/cases/${r.caseRequestId}`} style={{ whiteSpace: "nowrap" }}>{r.caseNumber}</Link>
                  <span className="note" style={{ display: "block", fontSize: 11 }}>{r.action}</span>
                </td>
                <td style={{ padding: "4px 8px" }}>{r.clientName}</td>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}><b>{r.systemKey}</b>{r.validateOnly && <span className="note" style={{ marginLeft: 4, fontSize: 10 }}>verify</span>}</td>
                <td style={{ padding: "4px 8px" }}><Badge verdict={r.verdict} /></td>
                <td style={{ padding: "4px 8px", overflowWrap: "anywhere", wordBreak: "break-word", color: r.done ? "var(--muted)" : r.verdict === "failed" ? "var(--err-fg)" : r.verdict === "warning" ? "var(--warn-fg)" : "var(--muted)" }}>
                  {/* Actions float top-right INSIDE the message cell: pinned to the row's right edge while
                      the message text fills the full width and wraps under them — no sparse actions column. */}
                  {(r.verdict === "warning" || r.verdict === "failed") && (
                    <span style={{ float: "right", marginLeft: 10, display: "inline-flex", gap: 4, whiteSpace: "nowrap" }}>
                      <CopyButton text={r.copyText} />
                      <FixButton fingerprint={r.fingerprint} resolved={r.done} count={r.count} />
                    </span>
                  )}
                  {r.messages.length ? r.messages.map((m, i) => <div key={i} style={{ marginBottom: 2 }}>{m}</div>) : (r.verdict === "verified" ? "—" : "")}
                  {r.done && <div className="note" style={{ fontSize: 10 }}>fixed{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}</div>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} style={{ padding: "1rem 8px", color: "var(--muted, #6b7280)" }}>{emptyText}</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
