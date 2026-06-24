"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatDateOnly, formatDateTime } from "@/lib/dates";

export type CaseRowVM = {
  id: string;
  action: string;
  status: string;
  paused?: boolean; // operator pause or blocked on missing credentials — shown as "paused"
  pausedBy?: "needs_info" | "scheduled" | "operator" | "creds" | null;
  warnings?: string[]; // completed-with-warnings: badge goes orange, these show on hover
  subject: string | null;
  serviceNowCaseNumber: string | null;
  clientName: string;
  jobCount: number;
  statusHint: string;
  effectiveDate: string | null;
  immediate?: boolean; // offboard with no scheduled date (subject says "Immediate")
  lastRunIso?: string | null; // when the case last executed (most recent job start/finish)
  ranBy?: string | null; // operator who last ran it (email), or null
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
  failed: "#b3261e",
  completed: "#2e7d32",
  needs_manual: "#8a6d00",
  needs_approval: "#8a6d00",
  running: "#1565c0",
};

type SortKey = "subject" | "clientName" | "action" | "serviceNowCaseNumber" | "jobCount" | "status" | "effectiveDate" | "lastRun" | "createdAt";
type SortDir = "asc" | "desc";

function haystack(c: CaseRowVM): string {
  return [c.subject, c.clientName, c.action, c.serviceNowCaseNumber, STATUS_LABEL[c.status] ?? c.status, c.statusHint, ...(c.warnings ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Completed is only green when 100% clean: any step warning turns the badge orange (the run
// report's warning color) and the hover lists the warning lines. The count is warning STEPS
// (distinct systems, the lines are "System: …"-prefixed) so it matches the run report's summary
// — one step with two WARN actions is still one warning.
function StatusBadge({ c }: { c: CaseRowVM }) {
  const warns = c.status === "completed" ? (c.warnings ?? []) : [];
  const steps = new Set(warns.map((w) => w.split(":")[0])).size;
  const title = warns.length ? warns.join("\n") : c.statusHint || undefined;
  return (
    <span
      className="badge"
      title={title}
      style={{
        color: c.paused ? "#8a6d00" : warns.length ? "#b45309" : STATUS_COLOR[c.status],
        cursor: title ? "help" : undefined,
        textDecoration: title ? "underline dotted" : undefined,
        textUnderlineOffset: 3,
      }}
    >
      {c.paused
        ? (c.pausedBy === "needs_info" ? "ℹ︎ needs information" : c.pausedBy === "scheduled" ? "⏸ scheduled — resume to run" : c.pausedBy === "operator" ? "⏸ paused" : "paused — needs creds")
        : warns.length
          ? `completed — ${steps} warning${steps > 1 ? "s" : ""}`
          : (STATUS_LABEL[c.status] ?? c.status)}
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

export function CasesTable({ cases, trashed }: { cases: CaseRowVM[]; trashed: TrashedCaseRowVM[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  function remove(c: CaseRowVM) {
    const label = c.subject ?? c.serviceNowCaseNumber ?? c.id.slice(0, 8);
    if (!confirm(`Move case "${label}" to the trash? It leaves the list and is restorable for 30 days.`)) return;
    call(c.id, { method: "DELETE" });
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
    const filtered = cases.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (terms.length === 0) return true;
      const hay = haystack(c);
      return terms.every((t) => hay.includes(t));
    });
    const sorted = [...filtered].sort((a, b) => compare(a, b, sortKey));
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [cases, terms, statusFilter, sortKey, sortDir]);

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
        <select className="inline" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <span className="note" style={{ marginLeft: "auto" }}>{visible.length} of {cases.length}</span>
      </div>
      {selected.size > 0 && (
        <div className="filters" style={{ marginTop: "0.4rem", alignItems: "center", gap: 8 }}>
          <b>{selected.size} selected</b>
          <button className="danger" disabled={busyId === "bulk"} onClick={() => bulkTrash([...selected])}>
            {busyId === "bulk" ? "moving…" : "🗑 Send to trash"}
          </button>
          <button onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      {error && <p className="note danger">{error}</p>}

      <table>
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.id} style={selected.has(c.id) ? { background: "#eff6ff" } : undefined}>
              <td><input type="checkbox" checked={selected.has(c.id)} aria-label="Select case" onChange={() => toggleSel(c.id)} /></td>
              <td><Link href={`/cases/${c.id}`}>{c.subject ?? c.id.slice(0, 8)}</Link></td>
              <td className="muted">{c.clientName}</td>
              <td><span className="badge">{c.action}</span></td>
              <td className="muted">{c.serviceNowCaseNumber ?? "—"}</td>
              <td className="muted">{c.jobCount}</td>
              <td><StatusBadge c={c} /></td>
              <td className="muted" style={{ whiteSpace: "nowrap" }} title={c.effectiveDate ? (c.action === "offboard" ? "Offboarding date" : "Start date") : c.immediate ? "Immediate offboard — process now" : undefined}>
                {c.effectiveDate
                  ? formatDateOnly(c.effectiveDate)
                  : c.immediate
                    ? <span className="badge" style={{ color: "#b45309", borderColor: "#fde68a", background: "#fffbeb" }}>Immediate</span>
                    : "—"}
              </td>
              <td className="muted" style={{ whiteSpace: "nowrap" }} title={c.lastRunIso ? "Most recent step run" : "Hasn't run yet"}>
                {formatDateTime(c.lastRunIso)}
                {c.ranBy && <div className="note" style={{ fontSize: 11 }}>by {c.ranBy}</div>}
              </td>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(c.createdAtIso).toLocaleDateString()}</td>
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                <button
                  onClick={() => remove(c)}
                  disabled={busyId === c.id}
                  title="Move this case to the trash (restorable for 30 days)"
                  style={{ color: "#b3261e" }}
                >
                  {busyId === c.id ? "Removing…" : "Remove"}
                </button>
              </td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={11} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
                {cases.length === 0 ? "No cases yet. Import a ServiceNow ticket or create one." : "No cases match your search."}
              </td>
            </tr>
          )}
        </tbody>
      </table>

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
                  <td style={{ color: t.daysLeft <= 3 ? "#b3261e" : undefined }}>{t.daysLeft} day{t.daysLeft === 1 ? "" : "s"}</td>
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
                      style={{ marginLeft: 6, color: "#b3261e" }}
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
