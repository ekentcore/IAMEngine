// Feature-request board — every signed-in operator can see what's been requested and where each
// request stands (New / Being scripted / Planned / Implemented / Rejected). Admins (settings.manage)
// get the inline status editor; everyone else sees a read-only board. Requests are filed from the
// 💡 button in the header.
//
// A request drops off the board 7 days after it is marked Implemented and lands in the collapsed
// Completed table at the bottom — still there, still searchable by its number, just not in the way.
// Global and super admins (feature_request.hide) can hide one sooner or grant it another 7 days.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { frNumber } from "@/lib/feature-requests/visibility";
import { loadFeatureRequests } from "../settings/_lib/loader";
import { FeatureRequestsAdmin } from "../settings/_components/feature-requests-admin";
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

  const board = requests.filter((r) => !r.hidden);
  const completed = requests.filter((r) => r.hidden);
  const open = board.filter((r) => r.status !== "done" && r.status !== "declined").length;
  const shipped = requests.filter((r) => r.status === "done").length;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Feature requests</h1>
          <p className="note">
            {requests.length} total · {open} open · {shipped} implemented — filed from the 💡 button in the header.
            {canManage ? " Set a status to keep the queue honest." : " An admin sets the status."}
          </p>
        </div>
      </div>

      {requests.length === 0 ? (
        <p className="note">No feature requests yet — the 💡 button in the header files one.</p>
      ) : canManage ? (
        <FeatureRequestsAdmin initial={requests} canHide={canHide} />
      ) : (
        <div>
          {board.length === 0 ? (
            <p className="note">Nothing open — every request has been completed.</p>
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
          {/* Read-only: the table renders, but without the admin's unhide control. */}
          <CompletedTable rows={completed} />
        </div>
      )}
    </main>
  );
}
