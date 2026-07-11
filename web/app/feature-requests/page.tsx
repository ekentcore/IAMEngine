// Feature-request board — every signed-in operator can see what's been requested and where each
// request stands (New / Being scripted / Planned / Implemented / Rejected). Admins (settings.manage)
// get the inline status editor; everyone else sees a read-only board. Requests are filed from the
// 💡 button in the header.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { loadFeatureRequests } from "../settings/_lib/loader";
import { FeatureRequestsAdmin } from "../settings/_components/feature-requests-admin";
import { FeatureStatusBadge } from "./_components/status-badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feature requests" };

export default async function FeatureRequestsPage() {
  let canManage = true;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me) redirect("/login");
    canManage = can(me.role, "settings.manage");
  }
  const requests = await loadFeatureRequests();

  const open = requests.filter((r) => r.status !== "done" && r.status !== "declined").length;
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
        <FeatureRequestsAdmin initial={requests} />
      ) : (
        <div>
          {requests.map((r) => (
            <div key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: "0.6rem" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <FeatureStatusBadge status={r.status} />
                <strong>{r.title}</strong>
                <span className="note">{r.authorEmail ?? "unknown"} · {new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
              {r.body && <p style={{ margin: "0.35rem 0 0", whiteSpace: "pre-wrap" }}>{r.body}</p>}
              {r.resolutionNote && <p className="note" style={{ margin: "0.35rem 0 0" }}>↳ {r.resolutionNote}</p>}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
