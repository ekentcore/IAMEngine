// Audit review v3 (the "Version 3" slider serves this at /audit): same data via the shared
// _lib/loader.tsx with plain-English actions and the alphabetical dropdown, plus the optional
// ?user=<id> filter banner. v3 chrome — the results table folds into a CollapsibleSection.
import Link from "next/link";
import { actionLabel } from "@/lib/audit/action-labels";
import { AuditFilters } from "../_components/audit-filters";
import { CollapsibleSection } from "../../_components/collapsible-section";
import { loadAuditPage, fmtDetail, fmtDetailLong, AUDIT_LIMIT, type AuditSearchParams } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit" };

export default async function AuditV3Page({ searchParams }: { searchParams: AuditSearchParams }) {
  const { rows, actionOptions, focusUser, q, actionParam, userId, target } = await loadAuditPage(searchParams);

  // Alphabetical by the English label.
  const sortedActions = [...actionOptions].sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
  const focusLabel = focusUser ? (focusUser.name || focusUser.email) : null;

  return (
    <main>
      <h1>Audit log</h1>
      <p className="note">{rows.length === AUDIT_LIMIT ? `Most recent ${AUDIT_LIMIT} matching events` : `${rows.length} matching events`} — who did what, when. Filter below.</p>
      {focusLabel && (
        <p className="note" style={{ marginTop: 4 }}>
          Showing the log for <b>{focusLabel}</b>. <Link href="/audit/v3">Show all</Link>
        </p>
      )}
      <AuditFilters
        actions={sortedActions}
        current={{ q, action: actionParam, days: searchParams.days ?? "7" }}
        basePath="/audit/v3"
        english
        multi
        extra={userId ? { user: userId } : {}}
      />
      <CollapsibleSection title="Events" count={rows.length}>
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
      </CollapsibleSection>
    </main>
  );
}
