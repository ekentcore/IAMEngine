// Cases v3 (the "Version 3" slider serves this at /cases): same data as v2 via the shared
// _lib/loader.ts. v3 chrome — the action buttons collapse into a single "Actions ▾" menu, matching
// the rest of the v3 pages; CasesTable already provides the sortable/filterable advanced table.
import { CasesToolbar } from "../_components/cases-toolbar";
import { CasesTable } from "../_components/cases-table";
import { loadCasesPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cases" };

export default async function CasesV3Page() {
  const { rows, trashedRows, clients } = await loadCasesPage();

  const open = rows.filter((c) => c.status !== "completed").length;
  const done = rows.length - open;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Cases</h1>
          <p className="note">{open} open · {done} completed · onboarding / offboarding requests</p>
        </div>
      </div>

      <CasesToolbar clients={clients} snScan variant="menu" />

      <CasesTable cases={rows} trashed={trashedRows} splitCompleted />
    </main>
  );
}
