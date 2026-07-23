// Go-live readiness preflight (feature #6) — a read-only page that aggregates every existing readiness
// signal into ONE red/green report and a top-line GO / NO-GO verdict. Data assembly (and the
// audit.view gate) live in _lib/loader.ts. This page dispatches NOTHING to a runner on load: cheap
// signals run live, async probes are read from their last cached result, and a fresh M365 sweep is an
// explicit button in the view that reuses /api/tools/fleet-m365.
import { PreflightView } from "./_components/preflight-view";
import { loadGoLivePreflight } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Go-live readiness" };

export default async function GoLivePage() {
  const vm = await loadGoLivePreflight();
  return <PreflightView vm={vm} />;
}
