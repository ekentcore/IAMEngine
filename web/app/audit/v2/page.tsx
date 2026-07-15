// Audit review v2: same data via the shared _lib/loader.tsx, but actions read in plain English,
// the action dropdown is alphabetical, and the optional ?user=<id> filter (linked from /users/v2)
// gets a "showing the log for …" banner.
import Link from "next/link";
import { actionLabel } from "@/lib/audit/action-labels";
import { AuditFilters } from "../_components/audit-filters";
import { loadAuditPage, fmtDetail, fmtDetailLong, AUDIT_LIMIT, type AuditSearchParams } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit (v2)" };

export default async function AuditV2Page({ searchParams }: { searchParams: AuditSearchParams }) {
  const { rows, actionOptions, focusUser, q, actionParam, userId, target } = await loadAuditPage(searchParams);

  // Alphabetical by the English label.
  const sortedActions = [...actionOptions].sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
  const focusLabel = focusUser ? (focusUser.name || focusUser.email) : null;

  return (
    <main>
      <h1>Audit log <span className="note">(v2)</span></h1>
      <p className="note">{rows.length === AUDIT_LIMIT ? `Most recent ${AUDIT_LIMIT} matching events` : `${rows.length} matching events`} — who did what, when. Filter below.</p>
      {focusLabel && (
        <p className="note" style={{ marginTop: 4 }}>
          Showing the log for <b>{focusLabel}</b>. <Link href="/audit/v2">Show all</Link>
        </p>
      )}
      <AuditFilters
        actions={sortedActions}
        current={{ q, action: actionParam, days: searchParams.days ?? "7" }}
        basePath="/audit/v2"
        english
        multi
        extra={userId ? { user: userId } : {}}
      />
      <table style={{ marginTop: "1rem" }}>
        <thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 190 }}>Who</th><th style={{ width: 220 }}>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="note tnum" style={{ whiteSpace: "nowrap" }}>{r.at.toLocaleString()}</td>
              <td>{r.user ? <span title={r.user.email}>{r.user.name || r.user.email}</span> : <span className="muted">{r.actor}</span>}</td>
              <td title={r.action}>{actionLabel(r.action)}</td>
              <td>{target(r)}</td>
              <td className="note" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fmtDetailLong(r.detail)}>{fmtDetail(r.detail)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="empty-state">No events match these filters.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
