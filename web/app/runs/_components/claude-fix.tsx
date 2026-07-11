"use client";

// "Fix with Claude" — hand a failing run-log line to the self-healing fix lane (POST
// /api/fix-tasks). The hook tracks one task per fingerprint and polls its status every 5s while
// queued/running; the chip shows progress and links the draft PR when one opens. A human always
// merges — this only files the PR.
import { useCallback, useEffect, useState } from "react";

export type FixTaskInfo = { status: string; prUrl?: string | null; error?: string };

export type FixableRow = { fingerprint: string; systemKey: string; messages: string[]; copyText: string };

export function useClaudeFixes() {
  const [tasks, setTasks] = useState<Record<string, FixTaskInfo>>({});

  // Poll the fingerprints with an in-flight task. 5s cadence; stops itself when nothing's active.
  useEffect(() => {
    const active = Object.keys(tasks).filter((fp) => tasks[fp].status === "queued" || tasks[fp].status === "running");
    if (active.length === 0) return;
    const id = setInterval(() => {
      for (const fp of active) {
        fetch(`/api/fix-tasks?fingerprint=${encodeURIComponent(fp)}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { task?: { status: string; prUrl: string | null } | null } | null) => {
            if (d?.task) setTasks((m) => ({ ...m, [fp]: { status: d.task!.status, prUrl: d.task!.prUrl } }));
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
      if (r.ok || r.status === 409) return; // 409 = one's already in flight — the poll shows its real status
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setTasks((m) => ({ ...m, [fp]: { status: "error", error: d.error ?? `failed (${r.status})` } }));
    } catch {
      setTasks((m) => ({ ...m, [fp]: { status: "error", error: "request failed" } }));
    }
  }, []);

  return { tasks, start };
}

const CHIP: Record<string, { label: string; fg: string }> = {
  queued: { label: "🤖 queued…", fg: "var(--muted, #6b7280)" },
  running: { label: "🤖 fixing…", fg: "var(--info-fg, #1d4ed8)" },
  no_change: { label: "🤖 no change", fg: "var(--muted, #6b7280)" },
  failed: { label: "🤖 fix failed", fg: "var(--err-fg, #b91c1c)" },
  error: { label: "🤖 error", fg: "var(--err-fg, #b91c1c)" },
};

export function ClaudeFixChip({ task }: { task?: FixTaskInfo }) {
  if (!task) return null;
  if (task.status === "opened_pr" && task.prUrl) {
    return <a href={task.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, whiteSpace: "nowrap" }} title="Draft PR opened — review and merge it yourself">🤖 PR ↗</a>;
  }
  const c = CHIP[task.status] ?? CHIP.queued;
  return (
    <span style={{ fontSize: 11, color: c.fg, whiteSpace: "nowrap" }} title={task.error ?? "Claude is working on this line in an isolated worktree — it opens a draft PR, you merge"}>
      {c.label}{task.status === "error" && task.error ? ` — ${task.error}` : ""}
    </span>
  );
}

// Non-v2 inline variant: a small button beside Copy/Fixed, replaced by the chip once triggered.
export function ClaudeFixButton({ row, task, onStart }: { row: FixableRow; task?: FixTaskInfo; onStart: (row: FixableRow) => void }) {
  if (task) return <ClaudeFixChip task={task} />;
  return (
    <button
      type="button"
      onClick={() => onStart(row)}
      title="Hand this failure to Claude Code: it diagnoses and fixes the code in an isolated worktree and opens a draft PR — a human merges"
      style={{ fontSize: 11, padding: "1px 7px" }}
    >
      🤖 Fix with Claude
    </button>
  );
}
