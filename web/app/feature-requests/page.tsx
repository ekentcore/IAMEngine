// Feature-request board — every signed-in operator can see what's been requested and where each
// request stands (New / Being scripted / Planned / Implemented / Rejected). Admins (settings.manage)
// get the inline status editor; everyone else sees a read-only board. Requests are filed from the
// 💡 button in the header.
//
// The board at the top is only what is REMAINING. Marking a request Implemented (or Rejected) moves
// it straight down into the "Implemented and closed" table — no waiting — so the length of the board
// is the size of the queue. Nothing is deleted: 7 days later a resolved request folds once more into
// the collapsed "Archived" table, still numbered, still searchable. Global and super admins
// (feature_request.hide) can archive one sooner or lift it back for another 7 days.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { frIsOpen } from "@/lib/feature-requests/status";
import { frNumber } from "@/lib/feature-requests/visibility";
import { frCounts } from "@/lib/feature-requests/counts";
import { loadFeatureRequests } from "./_lib/loader";
import { FeatureRequestsAdmin } from "./_components/feature-requests-admin";
import { FeatureRequestsSummary } from "./_components/feature-requests-summary";
import { FeatureStatusBadge } from "./_components/status-badge";
import { CompletedTable } from "./_components/completed-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feature requests" };

export default async function FeatureRequestsPage() {
  let canManage = true;
  let canHide = true; // auth disabled (dev) acts as super_admin
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me) redirect("/login");
    canManage = can(me.role, "settings.manage");
    canHide = can(me.role, "feature_request.hide");
  }
  const requests = await loadFeatureRequests();

  // Status decides the split, not the archive timer: a request is on the board while it is open, and
  // below it from the moment it is resolved.
  const board = requests.filter((r) => frIsOpen(r.status));
  const completed = requests.filter((r) => !frIsOpen(r.status));

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Feature requests</h1>
          {/* Live: the counts recompute in place when an admin re-triages a request — no reload. */}
          <FeatureRequestsSummary initial={frCounts(requests)} canManage={canManage} />
        </div>
      </div>

      {requests.length === 0 ? (
        <p className="note">No feature requests yet — the 💡 button in the header files one.</p>
      ) : canManage ? (
        <FeatureRequestsAdmin initial={requests} canHide={canHide} />
      ) : (
        <div>
          {board.length === 0 ? (
            <p className="note">Nothing remaining — every request has been implemented or closed.</p>
          ) : (
            board.map((r) => (
              <div key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: "0.6rem" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span className="mono tnum note">{frNumber(r.number)}</span>
                  <FeatureStatusBadge status={r.status} />
                  <strong>{r.title}</strong>
                  <span className="note">{r.authorEmail ?? "unknown"} · {new Date(r.createdAt).toLocaleDateString()}</span>
                </div>
                {r.body && <p style={{ margin: "0.35rem 0 0", whiteSpace: "pre-wrap" }}>{r.body}</p>}
                {r.resolutionNote && <p className="note" style={{ margin: "0.35rem 0 0" }}>↳ {r.resolutionNote}</p>}
              </div>
            ))
          )}
          {/* Read-only: the tables render, but without the admin's controls. */}
          <CompletedTable rows={completed} />
        </div>
      )}
    </main>
  );
}
