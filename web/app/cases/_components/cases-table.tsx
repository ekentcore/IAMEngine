"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateOnly, formatDateTime } from "@/lib/dates";

export type CaseRowVM = {
  id: string;
  action: string;
  status: string;
  paused?: boolean; // operator pause or blocked on missing credentials — shown as "paused"
  imported?: boolean; // freshly imported from ServiceNow, nothing run yet — shown as "imported"
  pausedBy?: "needs_info" | "scheduled" | "review" | "operator" | "creds" | null;
  warnings?: string[]; // completed-with-warnings: badge goes orange, these show on hover
  subject: string | null;
  serviceNowCaseNumber: string | null;
  clientName: string;
  jobCount: number;
  statusHint: string;
  effectiveDate: string | null;
  immediate?: boolean; // offboard with no scheduled date (subject says "Immediate")
  scheduledForIso?: string | null; // scheduled auto-resume time — shown on the "⏸ scheduled" badge
  lastRunIso?: string | null; // when the case last executed (most recent job start/finish)
  ranBy?: string | null; // operator who last ran it (email), or null
  lastActionLabel?: string | null; // most recent tracked action — "Imported"/"Unpaused"/"Paused"/"Verified"/…
  lastActionBy?: string | null; // who took that action (email), or null when not a signed-in user
  readiness?: "ready" | "partial" | "blocked" | "none"; // can this case's systems run? (are the creds set)
  readinessMissing?: string[]; // the unset secret names, for the tooltip
  createdAtIso: string;
};

export type TrashedCaseRowVM = {
  id: string;
  subject: string | null;
  serviceNowCaseNumber: string | null;
  clientName: string;
  status: string;
  jobCount: number;
  deletedAtIso: string;
  daysLeft: number;
};

const STATUS_LABEL: Record<string, string> = {
  queued: "queued",
  planning: "planning",
  running: "running",
  needs_manual: "needs manual",
  needs_approval: "needs approval",
  completed: "completed",
  failed: "failed",
};

// Status -> a subtle colour so the table scans at a glance (failed red, done green, attention amber).
const STATUS_COLOR: Record<string, string> = {
  failed: "var(--err-fg)",
  completed: "var(--ok-fg)",
  needs_manual: "var(--warn-fg)",
  needs_approval: "var(--warn-fg)",
  running: "var(--info-fg)",
};

type SortKey = "subject" | "clientName" | "action" | "serviceNowCaseNumber" | "jobCount" | "status" | "effectiveDate" | "lastRun" | "createdAt";
type SortDir = "asc" | "desc";

function haystack(c: CaseRowVM): string {
  return [c.subject, c.clientName, c.action, c.serviceNowCaseNumber, c.imported ? "imported" : STATUS_LABEL[c.status] ?? c.status, c.statusHint, ...(c.warnings ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Completed is only green when 100% clean: any step warning turns the badge orange (the run
// report's warning color) and the hover lists the warning lines. The count is warning STEPS
// (distinct systems, the lines are "System: …"-prefixed) so it matches the run report's summary
// — one step with two WARN actions is still one warning.
// Per-case run readiness: a small traffic-light dot — can this case actually run (are its systems'
// credentials set)? Distinct from status (lifecycle). Hidden when there's nothing to gate on, or once
// the case is terminal (readiness is moot then). The tooltip names the missing credentials.
const READINESS: Record<string, { color: string; label: string }> = {
  ready: { color: "var(--ok-fg)", label: "Ready to run — all required credentials are set" },
  partial: { color: "var(--warn-fg)", label: "Partially set up — some required credentials are missing" },
  blocked: { color: "var(--err-fg)", label: "Not set up — required credentials are missing" },
};
function ReadinessDot({ c }: { c: CaseRowVM }) {
  const r = c.readiness;
  if (!r || r === "none" || c.status === "completed" || c.status === "failed") return null;
  const m = READINESS[r];
  const miss = c.readinessMissing?.length ? ` — missing: ${c.readinessMissing.join(", ")}` : "";
  return (
    <span
      title={m.label + miss}
      aria-label={m.label}
      style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: m.color, marginRight: 6, verticalAlign: "middle", cursor: "help", flexShrink: 0 }}
    />
  );
}

// Compact "runs 7/20 8:00 AM" for the scheduled badge's second line (it's tiny — no month names).
function fmtRunsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function StatusBadge({ c }: { c: CaseRowVM }) {
  const warns = c.status === "completed" ? (c.warnings ?? []) : [];
  const steps = new Set(warns.map((w) => w.split(":")[0])).size;
  const title = warns.length ? warns.join("\n") : c.statusHint || undefined;
  // Split a long "… — resume to run" into a main label + a second line so the Status column stays
  // narrow (a wide single line was forcing the whole table wide).
  let main: string;
  let sub: string | null = null;
  if (c.imported) main = "✦ imported";
  else if (c.paused) {
    if (c.pausedBy === "needs_info") main = "ℹ︎ needs information";
    else if (c.pausedBy === "scheduled") { main = "⏸ scheduled"; sub = "resume to run"; }
    else if (c.pausedBy === "review") { if (c.lastRunIso) { main = "⏸ held"; sub = "resume to run"; } else main = "▶︎ Press Play to Start"; }
    else if (c.pausedBy === "operator") main = "⏸ paused";
    else main = "paused — needs creds";
    // A scheduled auto-resume overrides the generic sub-line whatever the hold reason — the sweep
    // releases ANY hold when the time arrives, so "runs <when>" is the truthful second line.
    if (c.scheduledForIso) sub = `runs ${fmtRunsAt(c.scheduledForIso)}`;
  } else if (warns.length) main = `completed — ${steps} warning${steps > 1 ? "s" : ""}`;
  else main = STATUS_LABEL[c.status] ?? c.status;
  return (
    <span
      className="badge"
      title={title}
      style={{
        color: c.imported ? "var(--info-fg)" : c.paused ? "var(--warn-fg)" : warns.length ? "var(--warn-fg)" : STATUS_COLOR[c.status],
        cursor: title ? "help" : undefined,
        textDecoration: title ? "underline dotted" : undefined,
        textUnderlineOffset: 3,
        whiteSpace: "nowrap",
        // .badge is display:inline-flex (a ROW) — a plain block child still sits on the same line, so for
        // the 2-line status we stack the flex direction to column (and square the pill a touch).
        ...(sub
          ? { flexDirection: "column" as const, alignItems: "center", gap: 0, borderRadius: 10, lineHeight: 1.15 }
          : { lineHeight: 1.25 }),
      }}
    >
      <span>{main}</span>
      {sub && <span style={{ fontSize: 9.5, fontWeight: 600, opacity: 0.8, marginTop: 1 }}>{sub}</span>}
    </span>
  );
}

function compare(a: CaseRowVM, b: CaseRowVM, key: SortKey): number {
  switch (key) {
    case "jobCount":
      return a.jobCount - b.jobCount;
    case "createdAt":
      return a.createdAtIso.localeCompare(b.createdAtIso);
    case "lastRun": {
      const av = a.lastRunIso ?? ""; const bv = b.lastRunIso ?? "";
      if (!av && bv) return 1; // never-run last
      if (av && !bv) return -1;
      return av.localeCompare(bv);
    }
    default: {
      const av = (a[key] ?? "") as string;
      const bv = (b[key] ?? "") as string;
      if (!av && bv) return 1; // empties last
      if (av && !bv) return -1;
      return av.localeCompare(bv);
    }
  }
}

// Multi-select status filter: a compact dropdown of checkboxes (empty selection = all statuses).
function StatusFilterMenu({ options, selected, onToggle, onClear }: {
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const label = selected.size === 0 ? "All statuses" : `${selected.size} selected`;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="inline" onClick={() => setOpen((o) => !o)} style={{ minWidth: 128, textAlign: "left", display: "inline-flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span>{label}</span><span aria-hidden style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 30, marginTop: 4, background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 8, boxShadow: "var(--shadow-1)", padding: 6, minWidth: 190 }}>
          {options.map((o) => (
            <label key={o.value} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", cursor: "pointer", borderRadius: 6, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(o.value)} style={{ width: "auto" }} />
              {o.label}
            </label>
          ))}
          {selected.size > 0 && (
            <button type="button" onClick={onClear} style={{ marginTop: 4, width: "100%", fontSize: 12 }}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}

export function CasesTable({ cases, trashed, splitCompleted = false }: { cases: CaseRowVM[]; trashed: TrashedCaseRowVM[]; splitCompleted?: boolean }) {
  const router = useRouter();
  // When splitCompleted is on (the /cases/v2 view), completed cases come OFF the working list into
  // their own collapsible table — the working table only carries open work. Default off: /cases is
  // unchanged (working === cases).
  const working = useMemo(() => (splitCompleted ? cases.filter((c) => c.status !== "completed") : cases), [cases, splitCompleted]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set()); // empty = all statuses (multi-select)
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSummary, setBulkSummary] = useState<string | null>(null); // "12 dispatched, 2 skipped" after a bulk run
  const [hoveredId, setHoveredId] = useState<string | null>(null); // row under the cursor — reveals its trash ×

  const toggleSel = (id: string) => setSelected((s) => { const x = new Set(s); x.has(id) ? x.delete(id) : x.add(id); return x; });

  async function call(id: string, init: RequestInit, url = `/api/cases/${id}`) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `Action failed (${res.status})`);
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  // Run transport: resume (play) a paused case, pause a running one, or cancel a running one (stop
  // in-flight steps + pause). Terminal cases (completed/failed) have nothing to control.
  function setPaused(c: CaseRowVM, paused: boolean) {
    call(c.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) }, `/api/cases/${c.id}/pause`);
  }
  function cancelRun(c: CaseRowVM) {
    const label = c.subject ?? c.serviceNowCaseNumber ?? c.id.slice(0, 8);
    if (!confirm(`Cancel the run for "${label}"? In-flight steps are stopped and the case is paused (not deleted).`)) return;
    call(c.id, { method: "POST" }, `/api/cases/${c.id}/cancel`);
  }

  function remove(c: CaseRowVM) {
    const label = c.subject ?? c.serviceNowCaseNumber ?? c.id.slice(0, 8);
    if (!confirm(`Move case "${label}" to the trash? It leaves the list and is restorable for 30 days.`)) return;
    call(c.id, { method: "DELETE" });
  }

  // Apply one run-control action across the selected cases via the bulk endpoint. Mirrors bulkTrash,
  // but one request (the server skips cases the action can't validly apply to). Confirm before a
  // destructive-ish cancel and before a large dispatch.
  async function bulkAction(action: "dispatch" | "pause" | "cancel" | "verify") {
    const ids = [...selected];
    if (ids.length === 0) return;
    const n = ids.length;
    if (action === "cancel" && !confirm(`Cancel the run for ${n} case${n > 1 ? "s" : ""}? In-flight steps are stopped and each case is paused (not deleted).`)) return;
    if (action === "dispatch" && n > 10 && !confirm(`Dispatch ${n} cases? Each paused case resumes and its steps start running.`)) return;
    setBusyId("bulk");
    setError(null);
    setBulkSummary(null);
    try {
      const res = await fetch("/api/cases/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, action }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? `Bulk action failed (${res.status})`); return; }
      const results: { skipped?: string; error?: string }[] = data?.results ?? [];
      const verb = { dispatch: "dispatched", pause: "paused", cancel: "cancelled", verify: "verifying" }[action];
      const skipped = results.filter((r) => r.skipped).length;
      const errored = results.filter((r) => r.error).length;
      const parts = [`${data?.ok ?? 0} ${verb}`];
      if (skipped) parts.push(`${skipped} skipped`);
      if (errored) parts.push(`${errored} failed`);
      setBulkSummary(parts.join(", "));
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function bulkTrash(ids: string[]) {
    if (ids.length === 0) return;
    if (!confirm(`Move ${ids.length} case${ids.length > 1 ? "s" : ""} to the trash? They leave the list and are restorable for 30 days.`)) return;
    setBusyId("bulk");
    setError(null);
    try {
      for (const id of ids) {
        const res = await fetch(`/api/cases/${id}`, { method: "DELETE" });
        if (!res.ok) { setError((await res.json().catch(() => null))?.error ?? `Failed to trash a case (${res.status})`); break; }
      }
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);

  const visible = useMemo(() => {
    const filtered = working.filter((c) => {
      if (statusFilter.size > 0) {
        const key = c.imported ? "imported" : c.status; // a case matches its own status, or "imported" while held after import
        if (!statusFilter.has(key)) return false;
      }
      if (terms.length === 0) return true;
      const hay = haystack(c);
      return terms.every((t) => hay.includes(t));
    });
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [working, terms, statusFilter, sortKey, sortDir]);

  // The separated completed cases (only when splitCompleted): search-filtered + sorted the same way,
  // shown in their own collapsible table below the working list.
  const completed = useMemo(() => {
    if (!splitCompleted) return [];
    const filtered = cases.filter((c) => c.status === "completed" && (terms.length === 0 || terms.every((t) => haystack(c).includes(t))));
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [cases, splitCompleted, terms, sortKey, sortDir]);

  const visibleIds = useMemo(() => visible.map((c) => c.id), [visible]);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  const toggleAll = () => setSelected((s) => {
    const x = new Set(s);
    if (allSelected) visibleIds.forEach((id) => x.delete(id));
    else visibleIds.forEach((id) => x.add(id));
    return x;
  });

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "createdAt" || key === "jobCount" ? "desc" : "asc");
    }
  }

  function SortHead({ k, label, num }: { k: SortKey; label: string; num?: boolean }) {
    return (
      <th className={`sortable${num ? " num" : ""}${sortKey === k ? " sorted" : ""}`} onClick={() => toggleSort(k)}>
        {label}
        <span className="arrow">{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
      </th>
    );
  }

  return (
    <>
      <div className="filters" style={{ marginTop: "1rem" }}>
        <div className="search-field">
          <span className="search-icon" aria-hidden>⌕</span>
          <input
            className="search"
            placeholder="Search subject, client, SN case, status, reason…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>
          )}
        </div>
        <StatusFilterMenu
          options={[
            { value: "imported", label: "imported (just imported)" },
            ...Object.entries(STATUS_LABEL)
              .filter(([k]) => !(splitCompleted && k === "completed")) // completed lives in its own table here
              .map(([k, label]) => ({ value: k, label })),
          ]}
          selected={statusFilter}
          onToggle={(v) => setStatusFilter((s) => { const x = new Set(s); x.has(v) ? x.delete(v) : x.add(v); return x; })}
          onClear={() => setStatusFilter(new Set())}
        />
        {/* Readiness legend: the leading dot on each case = can it run (are its systems' creds set). */}
        <span className="note" style={{ marginLeft: "auto", display: "inline-flex", gap: 12, alignItems: "center", fontSize: 11 }} title="The dot next to each case shows whether its systems' credentials are set">
          {(["ready", "partial", "blocked"] as const).map((k) => (
            <span key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: READINESS[k].color }} />{k}
            </span>
          ))}
        </span>
        <span className="note">{visible.length} of {working.length}</span>
      </div>
      {selected.size > 0 && (
        <div className="filters" style={{ marginTop: "0.4rem", alignItems: "center", gap: 8 }}>
          <b>{selected.size} selected</b>
          {/* Bulk run controls — the server skips cases each action can't apply to (e.g. dispatch only
              resumes paused, non-terminal cases). Dispatch only unpauses, so approval gates still hold. */}
          <button disabled={busyId === "bulk"} onClick={() => bulkAction("dispatch")} title="Resume paused cases so their steps start running">▶ Dispatch</button>
          <button disabled={busyId === "bulk"} onClick={() => bulkAction("pause")} title="Pause active cases">⏸ Pause</button>
          <button disabled={busyId === "bulk"} onClick={() => bulkAction("cancel")} title="Stop in-flight steps and pause active cases">⏹ Cancel</button>
          <button disabled={busyId === "bulk"} onClick={() => bulkAction("verify")} title="Re-run the read-only validator on cases with finished automated steps">✓ Verify</button>
          <button className="danger" disabled={busyId === "bulk"} onClick={() => bulkTrash([...selected])}>
            {busyId === "bulk" ? "working…" : "🗑 Send to trash"}
          </button>
          <button onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      {bulkSummary && <p className="note">{bulkSummary}</p>}
      {error && <p className="note danger">{error}</p>}

      <table className="desk-only">
        <thead>
          <tr>
            <th style={{ width: 24 }}>
              <input type="checkbox" checked={allSelected} aria-label="Select all" onChange={toggleAll}
                ref={(el) => { if (el) el.indeterminate = selectedVisible.length > 0 && !allSelected; }} />
            </th>
            <SortHead k="subject" label="Subject" />
            <SortHead k="clientName" label="Client" />
            <SortHead k="action" label="Action" />
            <SortHead k="serviceNowCaseNumber" label="SN case" />
            <SortHead k="jobCount" label="Jobs" num />
            <SortHead k="status" label="Status" />
            <SortHead k="effectiveDate" label="Start / off date" />
            <SortHead k="lastRun" label="Last run" />
            <SortHead k="createdAt" label="Created" />
            <th aria-label="Run controls"></th>
            <th style={{ width: 28 }} aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr
              key={c.id}
              onMouseEnter={() => setHoveredId(c.id)}
              onMouseLeave={() => setHoveredId((h) => (h === c.id ? null : h))}
              style={selected.has(c.id) ? { background: "var(--accent-soft)" } : undefined}
            >
              <td><input type="checkbox" checked={selected.has(c.id)} aria-label="Select case" onChange={() => toggleSel(c.id)} /></td>
              <td><ReadinessDot c={c} /><Link href={`/cases/${c.id}`}>{c.subject ?? c.id.slice(0, 8)}</Link></td>
              <td className="muted">{c.clientName}</td>
              <td><span className="badge">{c.action}</span></td>
              <td className="muted">{c.serviceNowCaseNumber ?? "—"}</td>
              <td className="muted">{c.jobCount}</td>
              <td>
                <StatusBadge c={c} />
                {c.lastActionLabel && (
                  <div className="note" style={{ fontSize: 11, marginTop: 2 }} title="Most recent action taken on this case">
                    {/* email on its OWN line — "Paused: long.email@core.tech" on one line was forcing the column wide */}
                    <div style={{ whiteSpace: "nowrap" }}>{c.lastActionLabel}{c.lastActionBy ? ":" : ""}</div>
                    {c.lastActionBy && <div style={{ opacity: 0.85 }}>{c.lastActionBy}</div>}
                  </div>
                )}
              </td>
              <td className="muted" style={{ whiteSpace: "nowrap" }} title={c.effectiveDate ? (c.action === "offboard" ? "Offboarding date/time" : "Start date") : c.immediate ? "Immediate offboard — process now" : undefined}>
                {c.effectiveDate
                  ? (() => {
                      const d = new Date(c.effectiveDate!);
                      // Offboards are scheduled for a specific time — show it below the date. Onboards are
                      // date-only (start date). Skip a meaningless midnight (date-only value).
                      const showTime = c.action === "offboard" && (d.getHours() !== 0 || d.getMinutes() !== 0);
                      return (
                        <>
                          <div>{formatDateOnly(c.effectiveDate!)}</div>
                          {showTime && <div className="note" style={{ fontSize: 11 }}>{d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>}
                        </>
                      );
                    })()
                  : c.immediate
                    ? <span className="badge" style={{ color: "var(--warn-fg)", borderColor: "var(--warn-bg)", background: "var(--warn-bg)" }}>Immediate</span>
                    : "—"}
              </td>
              <td className="muted" style={{ whiteSpace: "nowrap" }} title={c.lastRunIso ? "Most recent step run" : "Hasn't run yet"}>
                {c.lastRunIso ? (
                  (() => {
                    const d = new Date(c.lastRunIso!);
                    return (
                      <>
                        {/* date over time keeps this column narrow (was one wide "Jun 26, 2026, 9:13 AM" line) */}
                        <div>{d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</div>
                        <div className="note" style={{ fontSize: 11 }}>{d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
                        {c.ranBy && <div className="note" style={{ fontSize: 11 }}>by {c.ranBy}</div>}
                      </>
                    );
                  })()
                ) : (
                  // Not run yet — show how it got here ("Imported") instead of a bare "—" with a stray "by".
                  c.lastActionLabel ?? "—"
                )}
              </td>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(c.createdAtIso).toLocaleDateString()}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {(() => {
                  const terminal = c.status === "completed" || c.status === "failed";
                  const active = !c.paused && !terminal; // queued/planning/running/needs_* = "running"
                  const busy = busyId === c.id;
                  const off = "#c4c7cc";
                  return (
                    <span className="icon-stack">
                      <button className="icon-btn" title="Resume" aria-label="Resume" disabled={!c.paused || busy} style={{ color: c.paused && !busy ? "var(--ok-fg)" : off }} onClick={() => setPaused(c, false)}>{"▶︎"}</button>
                      <button className="icon-btn" title="Pause" aria-label="Pause" disabled={!active || busy} style={{ color: active && !busy ? "var(--warn-fg)" : off }} onClick={() => setPaused(c, true)}>{"⏸︎"}</button>
                      <button className="icon-btn" title="Cancel run (stop in-flight steps + pause)" aria-label="Cancel run" disabled={!active || busy} style={{ color: active && !busy ? "var(--err-fg)" : off }} onClick={() => cancelRun(c)}>{"⏹︎"}</button>
                    </span>
                  );
                })()}
              </td>
              <td style={{ width: 28, padding: 0, textAlign: "right" }}>
                <button
                  onClick={() => remove(c)}
                  disabled={busyId === c.id}
                  title="Move this case to the trash (restorable for 30 days)"
                  aria-label="Move this case to the trash"
                  style={{
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    color: "var(--err-fg)",
                    fontSize: 16,
                    lineHeight: 1,
                    padding: "2px 8px",
                    opacity: hoveredId === c.id || busyId === c.id ? 1 : 0,
                    transition: "opacity 120ms",
                  }}
                >
                  {busyId === c.id ? "…" : "×"}
                </button>
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={12} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
                {working.length === 0 ? (splitCompleted ? "No open cases — completed work is below." : "No cases yet. Import a ServiceNow ticket or create one.") : "No cases match your search."}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Mobile: a tappable card per case (same filtered `visible` list). Tap to open the case (where
          the run controls live). */}
      <div className="mob-only m-list">
        {visible.map((c) => (
          <Link key={c.id} href={`/cases/${c.id}`} className="m-card">
            <div className="m-card-top">
              <span className="m-card-title"><ReadinessDot c={c} />{c.subject ?? c.id.slice(0, 8)}</span>
              <StatusBadge c={c} />
            </div>
            <div className="m-card-sub">{c.clientName}</div>
            <div className="m-card-meta">
              <span><span className="k">action</span> {c.action}</span>
              {c.serviceNowCaseNumber && <span><span className="k">SN</span> {c.serviceNowCaseNumber}</span>}
              <span><span className="k">{c.action === "offboard" ? "off date" : "start"}</span> {c.effectiveDate ? formatDateOnly(c.effectiveDate) : c.immediate ? "Immediate" : "—"}</span>
              {c.lastRunIso && <span><span className="k">last run</span> {new Date(c.lastRunIso).toLocaleDateString([], { month: "short", day: "numeric" })}</span>}
            </div>
          </Link>
        ))}
        {visible.length === 0 && <div className="note" style={{ padding: "1rem 0" }}>No cases match.</div>}
      </div>

      {splitCompleted && (
        <details style={{ marginTop: "1.25rem" }}>
          <summary style={{ cursor: "pointer" }}>
            <b>Completed cases</b> <span className="note">({completed.length}) — off the working list, kept here for reference</span>
          </summary>
          <table style={{ marginTop: "0.5rem" }}>
            <thead>
              <tr>
                <th>Subject</th><th>Client</th><th>Action</th><th>SN case</th>
                <th className="num">Jobs</th><th>Status</th><th>Start / off date</th><th>Last run</th><th>Created</th>
                <th style={{ width: 28 }} aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {completed.map((c) => (
                <tr
                  key={c.id}
                  onMouseEnter={() => setHoveredId(c.id)}
                  onMouseLeave={() => setHoveredId((h) => (h === c.id ? null : h))}
                >
                  <td><ReadinessDot c={c} /><Link href={`/cases/${c.id}`}>{c.subject ?? c.id.slice(0, 8)}</Link></td>
                  <td className="muted">{c.clientName}</td>
                  <td><span className="badge">{c.action}</span></td>
                  <td className="muted">{c.serviceNowCaseNumber ?? "—"}</td>
                  <td className="muted">{c.jobCount}</td>
                  <td><StatusBadge c={c} /></td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{c.effectiveDate ? formatDateOnly(c.effectiveDate) : "—"}</td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {formatDateTime(c.lastRunIso)}
                    {c.ranBy && <div className="note" style={{ fontSize: 11 }}>by {c.ranBy}</div>}
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(c.createdAtIso).toLocaleDateString()}</td>
                  <td style={{ width: 28, padding: 0, textAlign: "right" }}>
                    <button
                      onClick={() => remove(c)}
                      disabled={busyId === c.id}
                      title="Move this case to the trash (restorable for 30 days)"
                      aria-label="Move this case to the trash"
                      style={{ border: "none", background: "none", cursor: "pointer", color: "var(--err-fg)", fontSize: 16, lineHeight: 1, padding: "2px 8px", opacity: hoveredId === c.id || busyId === c.id ? 1 : 0, transition: "opacity 120ms" }}
                    >
                      {busyId === c.id ? "…" : "×"}
                    </button>
                  </td>
                </tr>
              ))}
              {completed.length === 0 && (
                <tr><td colSpan={10} className="muted" style={{ textAlign: "center", padding: "1.5rem" }}>No completed cases{terms.length ? " match your search" : " yet"}.</td></tr>
              )}
            </tbody>
          </table>
        </details>
      )}

      {trashed.length > 0 && (
        <details style={{ marginTop: "1.25rem" }}>
          <summary style={{ cursor: "pointer" }}>
            <b>Trash</b> <span className="note">({trashed.length}) — restorable for 30 days, then permanently deleted</span>
          </summary>
          <table style={{ marginTop: "0.5rem" }}>
            <thead>
              <tr><th>Subject</th><th>Client</th><th>SN case</th><th>Status</th><th>Trashed</th><th>Auto-delete in</th><th></th></tr>
            </thead>
            <tbody>
              {trashed.map((t) => (
                <tr key={t.id}>
                  <td>{t.subject ?? t.id.slice(0, 8)}</td>
                  <td className="muted">{t.clientName}</td>
                  <td className="muted">{t.serviceNowCaseNumber ?? "—"}</td>
                  <td className="muted">{STATUS_LABEL[t.status] ?? t.status}</td>
                  <td className="muted">{new Date(t.deletedAtIso).toLocaleDateString()}</td>
                  <td style={{ color: t.daysLeft <= 3 ? "var(--err-fg)" : undefined }}>{t.daysLeft} day{t.daysLeft === 1 ? "" : "s"}</td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button
                      onClick={() => call(t.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore" }) })}
                      disabled={busyId === t.id}
                    >
                      Restore
                    </button>
                    <button
                      onClick={() => {
                        const label = t.subject ?? t.serviceNowCaseNumber ?? t.id.slice(0, 8);
                        if (confirm(`Permanently delete case "${label}" and its ${t.jobCount} job(s)? This can't be undone.`)) {
                          call(t.id, { method: "DELETE" }, `/api/cases/${t.id}?forever=1`);
                        }
                      }}
                      disabled={busyId === t.id}
                      style={{ marginLeft: 6, color: "var(--err-fg)" }}
                    >
                      Delete forever
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}
