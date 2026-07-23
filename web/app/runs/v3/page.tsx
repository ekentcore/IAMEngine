// Run outcomes v3 (the "Version 3" slider serves this at /runs): same data as /runs via the shared
// _lib/loader.ts — the same denser presentation as v2 (per-row actions behind a menu, fixed lines
// split into their own section), with the "Modules with issues" leaderboard folded into a
// CollapsibleSection. The RunLogTable is interactive, so it stays un-wrapped.
import Link from "next/link";
import { CollapsibleSection } from "../../_components/collapsible-section";
import { RunLogTable } from "../_components/run-log-table";
import { loadRunsPage, type RunsSearchParams } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Run outcomes" };

export default async function RunsV3Page({ searchParams }: { searchParams: RunsSearchParams }) {
  const data = await loadRunsPage(searchParams);
  if (!data) return null; // layout already redirects unauthenticated users to /login
  const { q, system, verdict, includeClean, includeResolved, summary, systems, rows, fixedRows, emptyText, initialFixTasks } = data;

  const open = rows.filter((r) => !r.done).length;
  const linkFor = (sys: string) => `/runs/v3?system=${encodeURIComponent(sys)}`;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Run outcomes</h1>
          <p className="note">
            {open} open line{open === 1 ? "" : "s"} · {summary.length} module{summary.length === 1 ? "" : "s"} with issues ·
            identical repeats are collapsed; <b>✓ Fixed</b> clears every occurrence of a line
          </p>
        </div>
      </div>

      {/* Modules with open problems — the "what to fix" leaderboard. */}
      {summary.length > 0 && (
        <CollapsibleSection title="Modules with issues">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
            {summary.map((m) => (
              <Link key={m.systemKey} href={linkFor(m.systemKey)} style={{ display: "inline-flex", gap: 6, alignItems: "center", border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: "2px 8px", fontSize: 12 }}>
                <b>{m.systemKey}</b>
                {m.failed > 0 && <span style={{ color: "#b91c1c" }}>{m.failed} error{m.failed === 1 ? "" : "s"}</span>}
                {m.warnings > 0 && <span style={{ color: "#92400e" }}>{m.warnings} warning{m.warnings === 1 ? "" : "s"}</span>}
              </Link>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Filters (GET so the view is shareable). The two include-toggles sit in one compact group. */}
      <form method="get" className="toolbar" style={{ gap: 8, flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <input name="q" defaultValue={q} placeholder="case # / client / message…" style={{ width: 230, fontSize: 13 }} />
        <select name="system" defaultValue={system} style={{ fontSize: 13 }}>
          <option value="">all modules</option>
          {systems.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="verdict" defaultValue={verdict} style={{ fontSize: 13 }}>
          <option value="">errors + warnings</option>
          <option value="failed">errors only</option>
          <option value="warning">warnings only</option>
          <option value="verified">successes</option>
          <option value="skipped">skipped</option>
        </select>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          include:
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, margin: 0 }} title="Include clean successes (verified / skipped / manual)">
            <input type="checkbox" name="all" value="1" defaultChecked={includeClean} style={{ width: "auto" }} /> clean
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, margin: 0 }} title="Include lines already marked Fixed (they land in the Fixed lines section below)">
            <input type="checkbox" name="resolved" value="1" defaultChecked={includeResolved} style={{ width: "auto" }} /> fixed
          </label>
        </span>
        <button type="submit">Filter</button>
        {(q || system || verdict || includeClean || includeResolved) && <Link href="/runs/v3" className="note">clear</Link>}
      </form>

      <RunLogTable rows={rows} emptyText={emptyText} v2 initialFixTasks={initialFixTasks} fixedRows={fixedRows} />
    </main>
  );
}
