"use client";

// Filter bar for the audit log — pushes the chosen filters into the URL (so the server re-queries
// and the view is shareable/bookmarkable).
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AuditFilters({ actions, current }: { actions: string[]; current: { q: string; action: string; days: string } }) {
  const router = useRouter();
  const [q, setQ] = useState(current.q);

  function apply(next: Partial<{ q: string; action: string; days: string }>) {
    const merged = { q, action: current.action, days: current.days, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.action) params.set("action", merged.action);
    if (merged.days && merged.days !== "7") params.set("days", merged.days);
    router.push(`/audit${params.toString() ? `?${params}` : ""}`);
  }

  return (
    <div className="filters">
      <form className="search-field" onSubmit={(e) => { e.preventDefault(); apply({}); }}>
        <span className="search-icon" aria-hidden>⌕</span>
        <input className="search" placeholder="Search action or actor…" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <select className="inline" value={current.action} onChange={(e) => apply({ action: e.target.value })} title="Filter by action">
        <option value="">All actions</option>
        {actions.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <select className="inline" value={current.days} onChange={(e) => apply({ days: e.target.value })} title="Time window">
        <option value="1">Last 24h</option>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="all">All time</option>
      </select>
      {(current.q || current.action || current.days !== "7") && (
        <button className="linklike" onClick={() => { setQ(""); router.push("/audit"); }}>clear</button>
      )}
    </div>
  );
}
