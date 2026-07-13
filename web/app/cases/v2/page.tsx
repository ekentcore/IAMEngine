// Cases v2 (the "Version 2" toggle serves this at /cases): same data as /cases via the shared
// _lib/loader.ts — only the header presentation differs (open/done counts, back-link).
import Link from "next/link";
import { CasesToolbar } from "../_components/cases-toolbar";
import { CasesTable } from "../_components/cases-table";
import { loadCasesPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cases (v2)" };

export default async function CasesV2Page() {
  const { rows, trashedRows, clients } = await loadCasesPage();

  const open = rows.filter((c) => c.status !== "completed").length;
  const done = rows.length - open;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Cases <span className="note">(v2)</span></h1>
          <p className="note">{open} open · {done} completed · completed work is kept in its own table</p>
        </div>
        <Link href="/cases" className="note" style={{ alignSelf: "flex-start" }}>← back to Cases</Link>
      </div>

      <CasesToolbar clients={clients} snScan />

      <CasesTable cases={rows} trashed={trashedRows} splitCompleted />
    </main>
  );
}
