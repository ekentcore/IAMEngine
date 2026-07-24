// Audit review (Auditor / Ops Manager / Global Admin — audit.view). Server-rendered, filtered by
// URL params so views are shareable. Answers "who did what, when, to which case/client".
// Data assembly lives in _lib/loader.tsx, shared with /audit/v2 (so this page also understands
// comma-separated ?action= lists and ?user=, even though its UI only offers the single select).
import { AuditFilters } from "./_components/audit-filters";
import { loadAuditPage, AUDIT_LIMIT, type AuditSearchParams } from "./_lib/loader";
import { AuditDetailCell } from "./_components/detail-cell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit" };

export default async function AuditPage({ searchParams }: { searchParams: AuditSearchParams }) {
  const { rows, actionOptions, q, actionParam, target } = await loadAuditPage(searchParams);

  return (
    <main>
      <h1>Audit log</h1>
      <p className="note">{rows.length === AUDIT_LIMIT ? `Most recent ${AUDIT_LIMIT} matching events` : `${rows.length} matching events`} — who did what, when. Filter below.</p>
      <AuditFilters actions={actionOptions} current={{ q, action: actionParam, days: searchParams.days ?? "7" }} />
      <table style={{ marginTop: "1rem" }}>
        <thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 190 }}>Who</th><th style={{ width: 200 }}>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="note tnum" style={{ whiteSpace: "nowrap" }}>{r.at.toLocaleString()}</td>
              <td>{r.user ? <span title={r.user.email}>{r.user.name || r.user.email}</span> : <span className="muted">{r.actor}</span>}</td>
              <td><code style={{ fontSize: 11.5 }}>{r.action}</code></td>
              <td>{target(r)}</td>
              <AuditDetailCell detail={r.detail} />
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="empty-state">No events match these filters.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
