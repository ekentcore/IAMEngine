// Azure cutover console (feature #2) — a guided, verified, reversible move of the brain from the Mac to
// Azure. Data assembly + the settings.manage gate live in _lib/loader.ts; the client view orchestrates
// the already-built machinery (heartbeat migrate directive, feature #7 drain, pg_dump/restore verify)
// and dispatches nothing on load.
import { CutoverView } from "./_components/cutover-view";
import { loadCutover } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Azure cutover" };

export default async function CutoverPage() {
  const vm = await loadCutover();
  return <CutoverView vm={vm} />;
}
