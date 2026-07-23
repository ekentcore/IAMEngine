// Connection tests v3 (the "Version 3" slider serves this at /health/connections): identical data to
// v2 via the shared _lib/loader.ts. v3 chrome — clean header (no v1 back-link, no "(v2)" label); the
// status counts stay in the header line and the interactive ConnectionsView renders directly.
import { ConnectionsView } from "../_components/connections-view";
import { loadConnectionsPage, loadSweepSchedule } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connection tests" };

export default async function ConnectionsV3Page() {
  const [rows, schedule] = await Promise.all([loadConnectionsPage(), loadSweepSchedule()]);

  const counts = { ok: 0, fail: 0, running: 0, pending: 0 };
  for (const r of rows) {
    if (r.status === "ok") counts.ok++;
    else if (r.status === "fail") counts.fail++;
    else if (r.status === "running") counts.running++;
    else counts.pending++;
  }

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Connection tests</h1>
          <p className="note">
            {counts.ok} ok · {counts.fail} failing · {counts.running} running · {counts.pending} pending
            {" — "}per-client/system preflight; proves each credential actually connects + reads.
          </p>
        </div>
      </div>
      <ConnectionsView rows={rows} v2 schedule={schedule} />
    </main>
  );
}
