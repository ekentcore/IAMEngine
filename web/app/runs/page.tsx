// Run outcomes — the cross-case log of what each module did on every on/offboarding run
// (success / warning / error + messages). Built to track module problems and fix them. Server-
// rendered, filtered by URL params so a view (e.g. "all m365 failures") is shareable.
import Link from "next/link";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { currentClientScope } from "@/lib/auth/client-scope";
import { listOutcomes, groupOutcomes, moduleIssueSummary, outcomeSystems } from "@/lib/runs/outcomes-repo";
import { FixButton } from "./_components/fix-button";
import { CopyButton } from "./_components/copy-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Run outcomes" };

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  failed: { bg: "#fef2f2", fg: "#b91c1c", label: "✗ error" },
  warning: { bg: "#fffbeb", fg: "#92400e", label: "⚠ warning" },
  verified: { bg: "#f0fdf4", fg: "#166534", label: "✓ success" },
  skipped: { bg: "#f3f4f6", fg: "#6b7280", label: "skipped" },
  manual: { bg: "#eef2ff", fg: "#3730a3", label: "✋ manual" },
  pending: { bg: "#f3f4f6", fg: "#6b7280", label: "pending" },
};

function Badge({ verdict }: { verdict: string }) {
  const s = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.pending;
  return <span style={{ background: s.bg, color: s.fg, borderRadius: 6, padding: "1px 7px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{s.label}</span>;
}

function fmtTime(d: Date): string {
  return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default async function RunsPage({ searchParams }: { searchParams: { q?: string; system?: string; verdict?: string; all?: string; resolved?: string } }) {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me) return null; // layout already redirects unauthenticated users to /login
  }

  const q = (searchParams.q ?? "").trim();
  const system = (searchParams.system ?? "").trim();
  const verdict = (searchParams.verdict ?? "").trim();
  const includeClean = searchParams.all === "1";
  const includeResolved = searchParams.resolved === "1";

  // Scope-gate to the operator's visible clients (the log carries clientId).
  const scope = await currentClientScope(db);
  const [rawRows, summary, systems] = await Promise.all([
    listOutcomes(db, { q: q || undefined, system: system || undefined, verdict: verdict || undefined, includeClean, includeResolved, scope }),
    moduleIssueSummary(db, scope),
    outcomeSystems(db, scope),
  ]);
  // Collapse identical lines (same case + line) into one entry with an occurrence count, so the log
  // isn't a wall of repeats; "Fixed" then resolves every occurrence at once.
  const rows = groupOutcomes(rawRows);

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

      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line, #e5e7eb)" }}>
            <th style={{ padding: "4px 8px" }}>When</th>
            <th style={{ padding: "4px 8px" }}>Case</th>
            <th style={{ padding: "4px 8px" }}>Client</th>
            <th style={{ padding: "4px 8px" }}>Module</th>
            <th style={{ padding: "4px 8px" }}>Result</th>
            <th style={{ padding: "4px 8px" }}>Message</th>
            <th style={{ padding: "4px 8px" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const done = Boolean(r.resolvedAt);
            return (
            <tr key={r.id} style={{ borderBottom: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top", opacity: done ? 0.5 : 1 }}>
              <td style={{ padding: "4px 8px", whiteSpace: "nowrap", color: "var(--muted, #6b7280)" }}>{fmtTime(r.at)}{r.count > 1 && <span className="note" style={{ marginLeft: 4 }}>×{r.count}</span>}</td>
              <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                <Link href={`/cases/${r.caseRequestId}`}>{r.caseNumber}</Link>
                <span className="note" style={{ marginLeft: 4, fontSize: 11 }}>{r.action}</span>
              </td>
              <td style={{ padding: "4px 8px" }}>{r.clientName}</td>
              <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}><b>{r.systemKey}</b>{r.validateOnly && <span className="note" style={{ marginLeft: 4, fontSize: 10 }}>verify</span>}</td>
              <td style={{ padding: "4px 8px" }}><Badge verdict={r.verdict} /></td>
              <td style={{ padding: "4px 8px", color: done ? "var(--muted, #6b7280)" : r.verdict === "failed" ? "#b91c1c" : r.verdict === "warning" ? "#92400e" : "var(--muted, #6b7280)" }}>
                {r.messages.length ? r.messages.map((m, i) => <div key={i} style={{ marginBottom: 2 }}>{m}</div>) : (r.verdict === "verified" ? "—" : "")}
                {done && <div className="note" style={{ fontSize: 10 }}>fixed{r.resolvedBy ? ` by ${r.resolvedBy}` : ""}</div>}
              </td>
              <td style={{ padding: "4px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                {(r.verdict === "warning" || r.verdict === "failed") && (
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    {/* error is already messages[0] for a failed step (jobOutcome pushes it first), so
                        append it only when it isn't already shown — otherwise the copy duplicates it. */}
                    <CopyButton text={[`${r.systemKey} (${r.caseNumber})`, ...r.messages, ...(r.error && !r.messages.includes(r.error) ? [r.error] : [])].filter(Boolean).join("\n")} />
                    <FixButton fingerprint={r.fingerprint} resolved={done} count={r.count} />
                  </span>
                )}
              </td>
            </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} style={{ padding: "1rem 8px", color: "var(--muted, #6b7280)" }}>No {includeResolved ? "" : "open "}outcomes{verdict || system || q ? " match the filter" : !includeClean ? " — no open errors or warnings 🎉" : " yet"}.</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
