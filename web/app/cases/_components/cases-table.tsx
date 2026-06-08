"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export type CaseRowVM = {
  id: string;
  action: string;
  status: string;
  subject: string | null;
  serviceNowCaseNumber: string | null;
  clientName: string;
  jobCount: number;
  statusHint: string;
  effectiveDate: string | null;
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

type SortKey = "subject" | "clientName" | "action" | "serviceNowCaseNumber" | "jobCount" | "status" | "effectiveDate" | "createdAt";
type SortDir = "asc" | "desc";

function haystack(c: CaseRowVM): string {
  return [c.subject, c.clientName, c.action, c.serviceNowCaseNumber, STATUS_LABEL[c.status] ?? c.status, c.statusHint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function compare(a: CaseRowVM, b: CaseRowVM, key: SortKey): number {
  switch (key) {
    case "jobCount":
      return a.jobCount - b.jobCount;
    case "createdAt":
      return a.createdAtIso.localeCompare(b.createdAtIso);
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
      {error && <p className="note danger">{error}</p>}

      <table>
        <thead>
          <tr>
            <SortHead k="subject" label="Subject" />
            <SortHead k="clientName" label="Client" />
            <SortHead k="action" label="Action" />
            <SortHead k="serviceNowCaseNumber" label="SN case" />
            <SortHead k="jobCount" label="Jobs" num />
            <SortHead k="status" label="Status" />
            <SortHead k="effectiveDate" label="Start / off date" />
            <SortHead k="createdAt" label="Created" />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/cases/${c.id}`}>{c.subject ?? c.id.slice(0, 8)}</Link></td>
              <td className="muted">{c.clientName}</td>
              <td><span className="badge">{c.action}</span></td>
              <td className="muted">{c.serviceNowCaseNumber ?? "—"}</td>
              <td className="muted">{c.jobCount}</td>
              <td>
                <span
                  className="badge"
                  title={c.statusHint || undefined}
                  style={{
                    color: STATUS_COLOR[c.status],
                    cursor: c.statusHint ? "help" : undefined,
                    textDecoration: c.statusHint ? "underline dotted" : undefined,
                    textUnderlineOffset: 3,
                  }}
                >
                  {STATUS_LABEL[c.status] ?? c.status}
                </span>
              </td>
              <td className="muted" title={c.effectiveDate ? (c.action === "offboard" ? "Offboarding date" : "Start date") : undefined}>{c.effectiveDate ?? "—"}</td>
              <td className="muted">{new Date(c.createdAtIso).toLocaleDateString()}</td>
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
              <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
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
