"use client";

// The run-log table with multi-select: tick the open errors/warnings and Fix them in one go. Rows are
// computed server-side (page.tsx) and passed in as a serializable VM. Per-row Copy/Fix still work.
import Link from "next/link";
import type { CredFailure } from "@/lib/jobs/cred-failure";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionsMenu, type ActionsMenuItem } from "../../_components/actions-menu";
import { CopyButton } from "./copy-button";
import { FixButton } from "./fix-button";
import { ClaudeFixButton, ClaudeFixChip, FixReviewPanel, useClaudeFixes, type FixTaskInfo } from "./claude-fix";
import { GodfatherEgg } from "./godfather-egg";
import { WompEgg } from "./womp-egg";
import { ThisIsFineEgg } from "./thisisfine-egg";
import { resolveManyOutcomes, resolveOutcomes, reopenOutcomes } from "../actions";
import { copyText, copyFailureHint } from "@/lib/clipboard";

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
  credFailure: CredFailure | null; // structured broker "why" when the problem was a credential
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


// The broker's structured credential verdict: the code is the scriptable part; the fix line tells
// the operator (or a sweep) exactly what to change. Rendered above the free-text messages.
function CredChip({ cf }: { cf: CredFailure | null }) {
  if (!cf) return null;
  return (
    <div style={{ marginBottom: 3 }}>
      <span style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", borderRadius: 6, padding: "1px 7px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" }}>
        credential · {cf.code} · {cf.secretName}
      </span>
      <div className="note" style={{ fontSize: 12, marginTop: 2 }}>fix: {cf.fix}</div>
    </div>
  );
}

function Badge({ verdict }: { verdict: string }) {
  const s = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.pending;
  // gf-err-badge: hook for the godfather egg — inert outside body.gf-mode.
  return <span className={verdict === "failed" ? "gf-err-badge" : undefined} style={{ background: s.bg, color: s.fg, borderRadius: 6, padding: "1px 7px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{s.label}</span>;
}

// Only OPEN errors/warnings can be Fixed — those are the selectable rows.
const isFixable = (r: RunLogRow) => !r.done && (r.verdict === "warning" || r.verdict === "failed") && !!r.fingerprint;

// v2 presentation: per-row Copy/Fixed collapse into the shared "Actions ▾" menu, and fixed lines
// come OFF the main table into their own <details> below (mirrors the cases v2 completed-split).
// Non-v2 rendering is unchanged. initialFixTasks: the latest fix-lane task per fingerprint,
// server-seeded so proposals survive reloads and auto-filed tasks are visible without a click.
export function RunLogTable({ rows, emptyText, v2 = false, initialFixTasks, fixedRows }: { rows: RunLogRow[]; emptyText: string; v2?: boolean; initialFixTasks?: Record<string, FixTaskInfo>; fixedRows?: RunLogRow[] }) {
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

  // Copy every selected line's full text in one go — so a whole batch of failures can be pasted
  // into a ticket/chat/Claude at once. Table order (not click order), one line per fingerprint,
  // blank-line separated so multi-line messages stay readable.
  const [copied, setCopied] = useState(false);
  async function copySelected() {
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const r of rows) {
      if (!sel.has(r.fingerprint) || seen.has(r.fingerprint)) continue;
      seen.add(r.fingerprint);
      picked.push(r.copyText);
    }
    const text = picked.join("\n\n");
    // The helper falls back to execCommand on an insecure origin and RETURNS whether it worked;
    // the old catch only fired on a throw, which an absent clipboard API never does.
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else { setErr(copyFailureHint()); }
  }

  // v2: mark one line Fixed / reopen it (same fingerprint semantics as FixButton).
  function fixOne(r: RunLogRow) {
    setErr(null);
    start(async () => {
      const res = r.done ? await reopenOutcomes(r.fingerprint) : await resolveOutcomes(r.fingerprint);
      if (!res.ok) { setErr(res.error); return; }
      router.refresh();
    });
  }

  // "Fix with AI" (self-healing lane): per-fingerprint task state + 5s polling live in the hook.
  const { tasks: fixTasks, start: startClaudeFix, apply: applyFix, dismiss: dismissFix } = useClaudeFixes(initialFixTasks);
  // The proposal review panel — open for at most one fingerprint at a time.
  const [reviewFp, setReviewFp] = useState<string | null>(null);
  const reviewRow = reviewFp ? rows.find((r) => r.fingerprint === reviewFp) : undefined;
  const reviewTask = reviewFp ? fixTasks[reviewFp] : undefined;

  const rowMenu = (r: RunLogRow): ActionsMenuItem[] => {
    const t = fixTasks[r.fingerprint];
    return [
      { label: "⧉ Copy", title: "Copy this line's message + error", onClick: () => { void copyText(r.copyText).then((ok) => { if (!ok) setErr(copyFailureHint()); }); } },
      r.done
        ? { label: "↺ Reopen", title: "Reopen this line", disabled: pending || !r.fingerprint, onClick: () => fixOne(r) }
        : { label: "✓ Fixed", title: r.count > 1 ? `Mark Fixed — clears all ${r.count} occurrences of this line for this case` : "Mark this line Fixed", disabled: pending || !r.fingerprint, onClick: () => fixOne(r) },
      ...(isFixable(r)
        ? [{
            label: "🤖 Fix with AI",
            title: "Hand this failure to the fix lane: the configured LLM proposes an exact fix you review on screen — applying opens a draft PR a human merges",
            disabled: !!t && (t.status === "queued" || t.status === "running" || t.status === "applying" || t.status === "proposed"),
            onClick: () => startClaudeFix(r),
          }]
        : []),
    ];
  };

  // v2 splits the resolved lines out of the working table; non-v2 keeps them inline (dimmed).
  // The Fixed section is fed by the loader's dedicated always-on resolved query (fixedRows prop), so a
  // just-fixed line shows up there without the "fixed" filter. Fall back to filtering `rows` (older
  // callers / non-v2 that don't pass the prop) to stay backward-compatible.
  const mainRows = v2 ? rows.filter((r) => !r.done) : rows;
  const resolvedRows = v2 ? (fixedRows ?? rows.filter((r) => r.done)) : [];

  return (
    <>
      {/* Easter eggs: "godfather" restyles error lines, "womp" gives them the trombone,
          "thisisfine" sets them on fire (godfather-egg / womp-egg / thisisfine-egg). */}
      <GodfatherEgg />
      <WompEgg />
      <ThisIsFineEgg />
      {sel.size > 0 && (
        <div className="toolbar" style={{ alignItems: "center", gap: 8, margin: "0.4rem 0" }}>
          <b>{sel.size} selected</b>
          <button type="button" onClick={copySelected} title="Copy every selected line's message + error to the clipboard">
            {copied ? "copied ✓" : `⧉ Copy ${sel.size}`}
          </button>
          <button type="button" disabled={pending} onClick={fixSelected} style={{ color: "#111827", fontWeight: 600 }}>
            {pending ? "Fixing…" : `✓ Fix ${sel.size} selected`}
          </button>
          <button type="button" onClick={() => setSel(new Set())}>Clear</button>
          {err && <span className="note danger">{err}</span>}
        </div>
      )}
      {/* v2 per-row actions live in a menu with no inline error slot — surface failures here. */}
      {v2 && err && sel.size === 0 && <p className="note danger" style={{ margin: "0.4rem 0" }}>{err}</p>}

      {/* Fixed layout + explicit column widths so a long, unbreakable message (URLs, snake_case tokens)
          wraps inside the Message column instead of widening the table and pushing the actions off-card. */}
      <table className="desk-only" style={{ width: "100%", tableLayout: "fixed", fontSize: 13, borderCollapse: "collapse" }}>
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
          {mainRows.map((r) => {
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
                <td className={r.verdict === "failed" ? "gf-err" : undefined} style={{ padding: "4px 8px", overflowWrap: "anywhere", wordBreak: "break-word", color: r.done ? "var(--muted)" : r.verdict === "failed" ? "var(--err-fg)" : r.verdict === "warning" ? "var(--warn-fg)" : "var(--muted)" }}>
                  {/* Actions float top-right INSIDE the message cell: pinned to the row's right edge while
                      the message text fills the full width and wraps under them — no sparse actions column. */}
                  {(r.verdict === "warning" || r.verdict === "failed") && (
                    <span style={{ float: "right", marginLeft: 10, display: "inline-flex", gap: 4, whiteSpace: "nowrap", alignItems: "center" }}>
                      {v2 ? (
                        <>
                          <ClaudeFixChip task={fixTasks[r.fingerprint]} onReview={() => setReviewFp(r.fingerprint)} />
                          <ActionsMenu items={rowMenu(r)} />
                        </>
                      ) : (
                        <>
                          <CopyButton text={r.copyText} />
                          <FixButton fingerprint={r.fingerprint} resolved={r.done} count={r.count} />
                          {isFixable(r) && <ClaudeFixButton row={r} task={fixTasks[r.fingerprint]} onStart={startClaudeFix} onReview={() => setReviewFp(r.fingerprint)} />}
                        </>
                      )}
                    </span>
                  )}
                  <CredChip cf={r.credFailure} />
                  {r.messages.length ? r.messages.map((m, i) => <div key={i} style={{ marginBottom: 2 }}>{m}</div>) : (r.verdict === "verified" ? "—" : "")}
                  {r.done && <div className="note" style={{ fontSize: 10 }}>fixed{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}</div>}
                </td>
              </tr>
            );
          })}
          {mainRows.length === 0 && (
            <tr><td colSpan={7} style={{ padding: "1rem 8px", color: "var(--muted, #6b7280)" }}>{emptyText}</td></tr>
          )}
        </tbody>
      </table>

      {/* Mobile: message-focused card per line, with the case/client/module + copy/Fixed actions. */}
      <div className="mob-only m-list">
        {mainRows.map((r) => (
          <div key={r.id} className="m-card" style={{ opacity: r.done ? 0.55 : 1 }}>
            <div className="m-card-top">
              <span className="m-card-title" style={{ fontSize: 13 }}><b>{r.systemKey}</b>{r.validateOnly && <span className="note" style={{ marginLeft: 4, fontSize: 10 }}>verify</span>}</span>
              <Badge verdict={r.verdict} />
            </div>
            <div className={r.verdict === "failed" ? "m-card-msg gf-err" : "m-card-msg"} style={{ color: r.verdict === "failed" ? "var(--err-fg)" : r.verdict === "warning" ? "var(--warn-fg)" : "var(--muted)" }}>
              {r.credFailure ? `credential · ${r.credFailure.code} · ${r.credFailure.secretName} — ` : ""}{r.messages.length ? r.messages.join(" ") : (r.verdict === "verified" ? "—" : "")}
            </div>
            <div className="m-card-meta">
              <Link href={`/cases/${r.caseRequestId}`}>{r.caseNumber}</Link>
              <span className="k">{r.clientName}</span>
              <span className="k">{r.atLabel}{r.count > 1 ? ` ×${r.count}` : ""}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              <CopyButton text={r.copyText} />
              <FixButton fingerprint={r.fingerprint} resolved={r.done} count={r.count} />
              {isFixable(r) && <ClaudeFixButton row={r} task={fixTasks[r.fingerprint]} onStart={startClaudeFix} onReview={() => setReviewFp(r.fingerprint)} />}
            </div>
          </div>
        ))}
        {mainRows.length === 0 && <div className="note" style={{ padding: "1rem 0" }}>{emptyText}</div>}
      </div>

      {/* v2: resolved lines live off the working table, kept for reference (mirrors cases v2's
          completed-split). Only populated when the "fixed" filter loads them. */}
      {v2 && (
        <details style={{ marginTop: "1.25rem" }}>
          <summary style={{ cursor: "pointer" }}>
            <b>Fixed lines</b> <span className="note">({resolvedRows.length}) — resolved; off the working list, kept here for reference</span>
          </summary>
          <table style={{ marginTop: "0.5rem", width: "100%", tableLayout: "fixed", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line, #e5e7eb)" }}>
                <th style={{ padding: "4px 8px", width: 120 }}>When</th>
                <th style={{ padding: "4px 8px", width: 100 }}>Case</th>
                <th style={{ padding: "4px 8px", width: 150 }}>Client</th>
                <th style={{ padding: "4px 8px", width: 116 }}>Module</th>
                <th style={{ padding: "4px 8px", width: 78 }}>Result</th>
                <th style={{ padding: "4px 8px" }}>Message</th>
              </tr>
            </thead>
            <tbody>
              {resolvedRows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top", opacity: 0.6 }}>
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
                  <td className={r.verdict === "failed" ? "gf-err" : undefined} style={{ padding: "4px 8px", overflowWrap: "anywhere", wordBreak: "break-word", color: "var(--muted)" }}>
                    <span style={{ float: "right", marginLeft: 10, whiteSpace: "nowrap" }}>
                      <ActionsMenu items={rowMenu(r)} />
                    </span>
                    <CredChip cf={r.credFailure} />
                    {r.messages.length ? r.messages.map((m, i) => <div key={i} style={{ marginBottom: 2 }}>{m}</div>) : "—"}
                    <div className="note" style={{ fontSize: 10 }}>fixed{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}</div>
                  </td>
                </tr>
              ))}
              {resolvedRows.length === 0 && (
                <tr><td colSpan={6} style={{ padding: "1rem 8px", color: "var(--muted, #6b7280)" }}>No fixed lines yet — mark an error “✓ Fixed” and it lands here.</td></tr>
              )}
            </tbody>
          </table>
        </details>
      )}

      {/* The fix lane's review panel: diagnosis + exact proposed edits (file, lines, before/after). */}
      {reviewFp && reviewTask && (
        <FixReviewPanel
          task={reviewTask}
          title={reviewRow ? `${reviewRow.systemKey} (${reviewRow.caseNumber})` : "fix task"}
          onClose={() => setReviewFp(null)}
          onApply={() => (reviewTask.id ? applyFix(reviewFp, reviewTask.id) : Promise.resolve("task id missing"))}
          onDismiss={() => (reviewTask.id ? dismissFix(reviewFp, reviewTask.id) : Promise.resolve("task id missing"))}
        />
      )}
    </>
  );
}
