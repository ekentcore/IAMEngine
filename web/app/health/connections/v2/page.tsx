// Connection tests v2 (reached via the Version 2 toggle): identical data to /health/connections via
// the shared _lib/loader.ts, but denser — client + system merge into one identity cell and the
// status counts sit in the header line instead of the filter bar.
import Link from "next/link";
import { ConnectionsView } from "../_components/connections-view";
import { loadConnectionsPage, loadSweepSchedule } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connection tests (v2)" };

export default async function ConnectionsV2Page() {
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
          <h1>Connection tests <span className="note">(v2)</span></h1>
          <p className="note">
            {counts.ok} ok · {counts.fail} failing · {counts.running} running · {counts.pending} pending
            {" — "}per-client/system preflight; proves each credential actually connects + reads.
          </p>
        </div>
        <Link href="/health/connections" className="note" style={{ alignSelf: "flex-start", whiteSpace: "nowrap" }}>← back to Connection tests</Link>
      </div>
      <ConnectionsView rows={rows} v2 schedule={schedule} />
    </main>
  );
}
