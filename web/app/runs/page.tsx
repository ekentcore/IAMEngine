// Run outcomes — the cross-case log of what each module did on every on/offboarding run
// (success / warning / error + messages). Built to track module problems and fix them. Server-
// rendered, filtered by URL params so a view (e.g. "all m365 failures") is shareable.
// Data comes from the shared _lib/loader.ts (also serves /runs/v2) — only presentation lives here.
import Link from "next/link";
import { RunLogTable } from "./_components/run-log-table";
import { loadRunsPage, type RunsSearchParams } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Run outcomes" };

export default async function RunsPage({ searchParams }: { searchParams: RunsSearchParams }) {
  const data = await loadRunsPage(searchParams);
  if (!data) return null; // layout already redirects unauthenticated users to /login
  const { q, system, verdict, includeClean, includeResolved, summary, systems, rows, emptyText } = data;

  const linkFor = (sys: string) => `/runs?system=${encodeURIComponent(sys)}`;

  return (
    <main style={{ maxWidth: 1100, padding: "1rem 1.25rem" }}>
      <h1>Run outcomes</h1>
      <p className="note" style={{ marginTop: 0 }}>
        Every on/offboarding step that ran, with its case, client, module and result. Warnings and errors are kept even
        after a re-run, so module problems can be tracked here and fixed.
      </p>

      {/* Modules with open problems — the "what to fix" leaderboard. */}
      {summary.length > 0 && (
        <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "0.6rem 0.8rem", margin: "0.6rem 0 1rem" }}>
          <b style={{ fontSize: 13 }}>Modules with issues</b>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
            {summary.map((m) => (
              <Link key={m.systemKey} href={linkFor(m.systemKey)} style={{ display: "inline-flex", gap: 6, alignItems: "center", border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: "2px 8px", fontSize: 12 }}>
                <b>{m.systemKey}</b>
                {m.failed > 0 && <span style={{ color: "#b91c1c" }}>{m.failed} error{m.failed === 1 ? "" : "s"}</span>}
                {m.warnings > 0 && <span style={{ color: "#92400e" }}>{m.warnings} warning{m.warnings === 1 ? "" : "s"}</span>}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Filters (GET so the view is shareable). */}
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
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, margin: 0 }}>
          <input type="checkbox" name="all" value="1" defaultChecked={includeClean} style={{ width: "auto" }} /> include clean successes
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, margin: 0 }}>
          <input type="checkbox" name="resolved" value="1" defaultChecked={includeResolved} style={{ width: "auto" }} /> show fixed
        </label>
        <button type="submit">Filter</button>
        {(q || system || verdict || includeClean || includeResolved) && <Link href="/runs" className="note">clear</Link>}
      </form>

      <p className="note">{rows.length} distinct line{rows.length === 1 ? "" : "s"}{verdict || system || q ? " (filtered)" : !includeClean ? " — open errors & warnings" : ""}{includeResolved ? " · including fixed" : ""}. Identical repeats are collapsed; <b>✓ Fixed</b> clears every occurrence of a line (and future re-runs of it).</p>

      <RunLogTable rows={rows} emptyText={emptyText} />
    </main>
  );
}
