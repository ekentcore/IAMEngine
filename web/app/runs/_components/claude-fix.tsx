"use client";

// "Fix with AI" — hand a failing run-log line to the self-healing fix lane (POST /api/fix-tasks).
// The hook tracks one task per fingerprint and polls its status every 5s while queued/running/
// applying; the chip shows progress and opens the REVIEW PANEL when the analysis lands: the
// diagnosis plus every proposed edit (file, lines, before/after). Applying a reviewed proposal
// opens a draft PR — a human always merges.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { FixProposal } from "@/lib/fixes/fix-tasks";

export type FixTaskInfo = {
  id?: string;
  status: string; // queued | running | proposed | no_change | failed | applying | opened_pr | dismissed | error (client-only)
  prUrl?: string | null;
  log?: string | null;
  proposal?: FixProposal | null;
  provider?: string | null;
  error?: string;
};

export type FixableRow = { fingerprint: string; systemKey: string; messages: string[]; copyText: string };

const ACTIVE = (s: string) => s === "queued" || s === "running" || s === "applying";

type TaskResponse = { task?: { id: string; status: string; prUrl: string | null; log: string | null; proposal: FixProposal | null; provider: string | null } | null };

// initial: server-seeded latest task per fingerprint, so proposals survive page reloads (and
// auto-fix-filed tasks are visible without anyone having clicked anything this session).
export function useClaudeFixes(initial?: Record<string, FixTaskInfo>) {
  const [tasks, setTasks] = useState<Record<string, FixTaskInfo>>(initial ?? {});
  const router = useRouter();

  // Poll the fingerprints with an in-flight task. 5s cadence; stops itself when nothing's active.
  useEffect(() => {
    const active = Object.keys(tasks).filter((fp) => ACTIVE(tasks[fp].status));
    if (active.length === 0) return;
    const id = setInterval(() => {
      for (const fp of active) {
        fetch(`/api/fix-tasks?fingerprint=${encodeURIComponent(fp)}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: TaskResponse | null) => {
            if (!d?.task) return;
            // Only update when something actually changed — otherwise every 5s poll would return a
            // fresh object, the [tasks] effect would re-run, and the interval would churn/reset.
            setTasks((m) => {
              const prev = m[fp];
              if (prev && prev.status === d.task!.status && (prev.prUrl ?? null) === (d.task!.prUrl ?? null)) return m;
              return { ...m, [fp]: { id: d.task!.id, status: d.task!.status, prUrl: d.task!.prUrl, log: d.task!.log, proposal: d.task!.proposal, provider: d.task!.provider } };
            });
          })
          .catch(() => { /* transient — keep polling */ });
      }
    }, 5000);
    return () => clearInterval(id);
  }, [tasks]);

  const start = useCallback(async (row: FixableRow) => {
    const fp = row.fingerprint;
    setTasks((m) => ({ ...m, [fp]: { status: "queued" } }));
    const title = `${row.systemKey}: ${(row.messages[0] ?? "run failed").split("\n")[0]}`.slice(0, 300);
    try {
      const r = await fetch("/api/fix-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: fp, title, context: row.copyText }),
      });
      if (r.ok || r.status === 409) {
        // Invalidate the client Router Cache for this route so navigating away and back re-fetches a
        // server render that SEEDS this now-existing task (loader.ts). Without this, the cached RSC
        // payload predates the task and the queued/running chip vanishes on return — every other
        // mutation in the app refreshes for the same reason. 409 = one's already in flight; refresh
        // too, so its real status seeds on return.
        router.refresh();
        return;
      }
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setTasks((m) => ({ ...m, [fp]: { status: "error", error: d.error ?? `failed (${r.status})` } }));
    } catch {
      setTasks((m) => ({ ...m, [fp]: { status: "error", error: "request failed" } }));
    }
  }, [router]);

  // Apply a reviewed proposal (worktree → tsc/tests → draft PR) — the poll takes over from there.
  const apply = useCallback(async (fp: string, taskId: string): Promise<string | null> => {
    const r = await fetch(`/api/fix-tasks/${taskId}/apply`, { method: "POST" });
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      return d.error ?? `failed (${r.status})`;
    }
    setTasks((m) => ({ ...m, [fp]: { ...m[fp], status: "applying" } }));
    router.refresh(); // keep the route's cached render in step with the new status (see start())
    return null;
  }, [router]);

  const dismiss = useCallback(async (fp: string, taskId: string): Promise<string | null> => {
    const r = await fetch(`/api/fix-tasks/${taskId}/dismiss`, { method: "POST" });
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      return d.error ?? `failed (${r.status})`;
    }
    setTasks((m) => ({ ...m, [fp]: { ...m[fp], status: "dismissed" } }));
    router.refresh(); // keep the route's cached render in step with the new status (see start())
    return null;
  }, [router]);

  return { tasks, start, apply, dismiss };
}

const CHIP: Record<string, { label: string; fg: string }> = {
  queued: { label: "🤖 queued…", fg: "var(--muted, #6b7280)" },
  running: { label: "🤖 analyzing…", fg: "var(--info-fg, #1d4ed8)" },
  proposed: { label: "🤖 fix ready — review", fg: "var(--ok-fg, #15803d)" },
  applying: { label: "🤖 applying…", fg: "var(--info-fg, #1d4ed8)" },
  no_change: { label: "🤖 no change", fg: "var(--muted, #6b7280)" },
  failed: { label: "🤖 fix failed", fg: "var(--err-fg, #b91c1c)" },
  dismissed: { label: "🤖 dismissed", fg: "var(--muted, #6b7280)" },
  error: { label: "🤖 error", fg: "var(--err-fg, #b91c1c)" },
};

// Terminal states with something to show open the review panel on click.
const REVIEWABLE = (t: FixTaskInfo) => (t.status === "proposed" && !!t.proposal) || ((t.status === "no_change" || t.status === "failed" || t.status === "dismissed") && !!t.log);

export function ClaudeFixChip({ task, onReview }: { task?: FixTaskInfo; onReview?: () => void }) {
  if (!task) return null;
  if (task.status === "opened_pr" && task.prUrl) {
    return <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, whiteSpace: "nowrap" }} title="Draft PR opened — review and merge it yourself">🤖 PR ↗</a>;
  }
  const c = CHIP[task.status] ?? CHIP.queued;
  if (REVIEWABLE(task) && onReview) {
    return (
      <button type="button" onClick={onReview}
        title={task.status === "proposed" ? "A fix is ready — click to review the proposed changes" : "Click to read the diagnosis"}
        style={{ fontSize: 11, color: c.fg, whiteSpace: "nowrap", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}>
        {c.label}
      </button>
    );
  }
  return (
    <span style={{ fontSize: 11, color: c.fg, whiteSpace: "nowrap" }} title={task.error ?? "The fix lane is working on this line — it proposes a fix you review; applying opens a draft PR"}>
      {c.label}{task.status === "error" && task.error ? ` — ${task.error}` : ""}
    </span>
  );
}

// Non-v2 inline variant: a small button beside Copy/Fixed, replaced by the chip once triggered.
export function ClaudeFixButton({ row, task, onStart, onReview }: { row: FixableRow; task?: FixTaskInfo; onStart: (row: FixableRow) => void; onReview?: () => void }) {
  if (task) return <ClaudeFixChip task={task} onReview={onReview} />;
  return (
    <button
      type="button"
      onClick={() => onStart(row)}
      title="Hand this failure to the fix lane: the configured LLM reads the code and proposes an exact fix you review on screen — applying opens a draft PR a human merges"
      style={{ fontSize: 11, padding: "1px 7px" }}
    >
      🤖 Fix with AI
    </button>
  );
}

// One proposed edit: file + line range header, then the exact before/after text.
function EditBlock({ edit }: { edit: FixProposal["edits"][number] }) {
  const pre = { margin: 0, padding: "6px 8px", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const, overflowX: "auto" as const };
  return (
    <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, marginBottom: 10, overflow: "hidden" }}>
      <div style={{ padding: "4px 8px", fontSize: 12, borderBottom: "1px solid var(--line, #e5e7eb)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <b style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowWrap: "anywhere" }}>{edit.file}</b>
        <span className="note">lines {edit.startLine}–{edit.endLine}</span>
        {edit.note && <span className="note">{edit.note}</span>}
      </div>
      <pre style={{ ...pre, background: "var(--err-bg, #fef2f2)", color: "var(--err-fg, #b91c1c)" }}>
        {edit.oldText.split("\n").map((l) => `- ${l}`).join("\n")}
      </pre>
      <pre style={{ ...pre, background: "var(--ok-bg, #f0fdf4)", color: "var(--ok-fg, #15803d)", borderTop: "1px solid var(--line, #e5e7eb)" }}>
        {edit.newText.split("\n").map((l) => `+ ${l}`).join("\n")}
      </pre>
    </div>
  );
}

// The review panel: a plain overlay + card (no portal, no library). Shows the diagnosis and the
// exact proposed edits; Apply hands the task to the apply worker (draft PR), Dismiss closes it out.
export function FixReviewPanel({ task, title, onClose, onApply, onDismiss }: {
  task: FixTaskInfo;
  title: string;
  onClose: () => void;
  onApply: () => Promise<string | null>;
  onDismiss: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canAct = task.status === "proposed" && !!task.id;

  async function act(fn: () => Promise<string | null>, closeAfter: boolean) {
    setBusy(true); setErr(null);
    const problem = await fn();
    setBusy(false);
    if (problem) setErr(problem);
    else if (closeAfter) onClose();
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "4vh 12px" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg, #fff)", color: "var(--fg, #111827)", borderRadius: 10, border: "1px solid var(--line, #e5e7eb)", width: "min(860px, 100%)", maxHeight: "88vh", overflowY: "auto", padding: "1rem 1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>🤖 {task.status === "proposed" ? "Proposed fix" : task.status === "no_change" ? "No change proposed" : "Fix attempt"} — {title}</h3>
          <button type="button" onClick={onClose} style={{ fontSize: 12 }}>✕ Close</button>
        </div>
        {task.provider && <p className="note" style={{ margin: "2px 0 0", fontSize: 11 }}>analyzed by {task.provider}</p>}

        {(task.proposal?.diagnosis || task.log) && (
          <p style={{ fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "0.75rem 0" }}>
            {task.proposal?.diagnosis ?? task.log}
          </p>
        )}

        {task.proposal?.edits?.map((e, i) => <EditBlock key={i} edit={e} />)}

        <div style={{ display: "flex", gap: 8, marginTop: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          {canAct && (
            <>
              <button type="button" disabled={busy} onClick={() => act(onApply, true)} style={{ fontWeight: 600 }}
                title="Applies these edits in an isolated copy of the code, runs the checks, and opens a draft pull request — a human merges">
                {busy ? "Working…" : "Apply & open draft PR"}
              </button>
              <button type="button" disabled={busy} onClick={() => act(onDismiss, true)}>Dismiss</button>
            </>
          )}
          {!canAct && (task.status === "no_change" || task.status === "failed") && !!task.id && (
            <button type="button" disabled={busy} onClick={() => act(onDismiss, true)}>Dismiss</button>
          )}
          {err && <span className="note" style={{ color: "var(--err-fg, #b91c1c)" }}>{err}</span>}
        </div>
        {canAct && (
          <p className="note" style={{ marginTop: 6, fontSize: 11 }}>
            Applying re-checks every edit against the current code first (drift = refuse), then runs tsc/tests before the draft PR opens. Nothing merges without a human.
          </p>
        )}
      </div>
    </div>
  );
}
