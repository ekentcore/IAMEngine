// Cases list (server component). Data assembly lives in _lib/loader.ts, shared with /cases/v2.
import { CasesToolbar } from "./_components/cases-toolbar";
import { CasesTable } from "./_components/cases-table";
import { loadCasesPage } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cases" };

export default async function CasesPage() {
  const { rows, trashedRows, clients } = await loadCasesPage();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Cases</h1>
          <p className="note">{rows.length} cases · onboarding / offboarding requests</p>
        </div>
      </div>

      <CasesToolbar clients={clients} />

      <CasesTable cases={rows} trashed={trashedRows} splitCompleted />
    </main>
  );
}
