// Fleet M365 audits — the two questions the per-client UI cannot answer.
//
//   Permissions  — "who needs UserAuthenticationMethod.ReadWrite.All?" A client's own gaps already show
//                  in its connection-test panel; only a sweep can pivot them BY permission, which is
//                  what you need to actually go and fix them.
//   Leaked seats — disabled users still holding a licence: leavers we are still paying for.
//
// A sweep takes minutes (a Delinea resolve + several Graph reads per tenant), so it runs in the
// background and this renders the last finished run. Data comes from _lib/loader.ts.
import Link from "next/link";
import { loadAuditsPage, type AuditsSearchParams } from "./_lib/loader";
import { ScanButton } from "./_components/scan-button";
import { PermissionPivotTable } from "./_components/permission-pivot";
import { EscalationHoldersTable } from "./_components/escalation-holders";
import { M365SetupFleet } from "./_components/m365-setup-fleet";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet audits" };

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? "" : "s"} ago`;
}

export default async function AuditsPage({ searchParams }: { searchParams: AuditsSearchParams }) {
  const data = await loadAuditsPage(searchParams);
  if (!data) return null; // layout redirects unauthenticated users; unpermitted see nothing
  const { tab, shown, live, permissions, leaks, escalation, grantHelp } = data;

  const Tab = ({ id, label }: { id: string; label: string }) => (
    <Link
      href={`/fleet-audit?tab=${id}`}
      style={{ padding: "6px 12px", borderBottom: tab === id ? "2px solid #111" : "2px solid transparent", fontWeight: tab === id ? 600 : 400 }}
    >
      {label}
    </Link>
  );

  return (
    <main style={{ maxWidth: 1100, padding: "1rem 1.25rem" }}>
      <h1>Fleet audits</h1>
      <p className="note" style={{ marginTop: 0 }}>
        Read-only sweeps across every client&apos;s Microsoft 365 credential. Nothing here changes anything — it tells you
        what to go and change.
      </p>

      <nav style={{ display: "flex", gap: 4, borderBottom: "1px solid #e5e7eb", marginBottom: 16 }}>
        <Tab id="permissions" label="Permissions" />
        <Tab id="escalation_holders" label="Extra access" />
        <Tab id="leaked_seats" label="Leaked seats" />
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <ScanButton kind={tab} initial={live} />
        <span className="muted" style={{ fontSize: 12 }}>
          {shown ? `last scan ${ago(shown.startedAt)}${shown.startedBy ? ` by ${shown.startedBy.replace(/^user:/, "")}` : ""}` : "never scanned"}
        </span>
      </div>

      {!shown ? (
        <p className="note">No scan has finished yet. Run one — it takes a few minutes.</p>
      ) : tab === "permissions" ? (
        <>
          <PermissionPivotTable pivot={permissions.pivot} roleIds={grantHelp.roleIds} resourceAppId={grantHelp.resourceAppId} />
          <p className="note" style={{ fontSize: 12, marginTop: 10 }}>
            {permissions.rows.filter((r) => r.status === "ok").length} of {permissions.rows.length} clients fully covered.
            A missing <em>optional</em> permission is a note, never a failure — the feature that needs it warns and carries on.
          </p>

          {/* An unconfirmed gap must never reach the to-do list above: Graph throttles a fleet sweep,
              and a report that cries "missing" because of a 429 is worse than no report. */}
          {permissions.unverified.length > 0 && (
            <p className="note" style={{ fontSize: 12, color: "#b45309" }}>
              {permissions.unverified.length} client(s) could not be fully read (Graph throttling) and are excluded above —
              re-run to confirm: {permissions.unverified.map((r) => r.client || r.slug).join(", ")}
            </p>
          )}
          {permissions.noCred.length > 0 && (
            <p className="note" style={{ fontSize: 12 }}>
              {permissions.noCred.length} client(s) have no usable credential, so nothing could be checked:{" "}
              {permissions.noCred.map((r) => r.client || r.slug).join(", ")}
            </p>
          )}
        </>
      ) : tab === "escalation_holders" ? (
        <>
          <EscalationHoldersTable pivot={escalation.pivot} holders={escalation.holders} />
          {escalation.unverified.length > 0 && (
            <p className="note" style={{ fontSize: 12, color: "#b45309" }}>
              {escalation.unverified.length} client(s) could not be fully read — a held role may be under-reported there:{" "}
              {escalation.unverified.map((r) => r.client || r.slug).join(", ")}
            </p>
          )}
          {escalation.noCred.length > 0 && (
            <p className="note" style={{ fontSize: 12 }}>
              {escalation.noCred.length} client(s) have no usable credential, so nothing could be checked:{" "}
              {escalation.noCred.map((r) => r.client || r.slug).join(", ")}
            </p>
          )}
        </>
      ) : leaks.rows.length === 0 ? (
        <p className="note">No disabled user is still holding a licence. Nothing leaking.</p>
      ) : (
        <>
          <p style={{ fontSize: 13 }}>
            <strong>{leaks.rows.length}</strong> disabled user(s) still holding a licence ·{" "}
            {leaks.shared} safe to reclaim now · {leaks.notShared} need the mailbox converted first · {leaks.unknown} unknown
          </p>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "6px 4px" }}>Client</th>
                <th style={{ padding: "6px 4px" }}>User</th>
                <th style={{ padding: "6px 4px" }}>Licences</th>
                <th style={{ padding: "6px 4px" }}>Mailbox</th>
                <th style={{ padding: "6px 4px" }}>What to do</th>
              </tr>
            </thead>
            <tbody>
              {leaks.rows.map((r) => (
                <tr key={`${r.slug}:${r.userPrincipalName}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px 4px" }}><Link href={`/clients/${r.slug}`}>{r.slug}</Link></td>
                  <td style={{ padding: "6px 4px" }}>{r.userPrincipalName}</td>
                  <td style={{ padding: "6px 4px" }}>{r.licenses.join(", ")}</td>
                  <td style={{ padding: "6px 4px", color: r.mailbox === "not-shared" ? "#b91c1c" : r.mailbox === "unknown" ? "#b45309" : undefined }}>
                    {r.mailbox === "shared" ? "shared" : r.mailbox === "not-shared" ? "NOT shared" : "unknown"}
                  </td>
                  <td style={{ padding: "6px 4px" }} className="muted">{r.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leaks.unknown > 0 && (
            <p className="note" style={{ fontSize: 12, marginTop: 10 }}>
              An unknown mailbox state usually means that tenant has not granted <code>MailboxSettings.Read</code>. The leak
              itself is still real — we just cannot say yet whether the licence is safe to pull. See the Permissions tab.
            </p>
          )}
        </>
      )}

      <M365SetupFleet />
    </main>
  );
}
