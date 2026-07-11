// Shared page-data loader for /runs and /runs/v2. Both variants render the SAME data —
// only presentation differs — so the auth check, scope, queries and the RunLogTable row
// view-models live here once. Adding a field here reaches both pages; adding it in a page
// file is the drift that broke features on other v2 pages.
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { currentClientScope } from "@/lib/auth/client-scope";
import { listOutcomes, groupOutcomes, moduleIssueSummary, outcomeSystems } from "@/lib/runs/outcomes-repo";
import type { RunLogRow } from "../_components/run-log-table";

export type RunsSearchParams = { q?: string; system?: string; verdict?: string; all?: string; resolved?: string };

function fmtTime(d: Date): string {
  return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Returns null for an unauthenticated request (the layout already redirects to /login).
export async function loadRunsPage(searchParams: RunsSearchParams) {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me) return null;
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
  const rows: RunLogRow[] = groupOutcomes(rawRows).map((r) => ({
    id: r.id,
    atLabel: fmtTime(r.at),
    count: r.count,
    caseRequestId: r.caseRequestId,
    caseNumber: r.caseNumber,
    action: r.action,
    clientName: r.clientName,
    systemKey: r.systemKey,
    validateOnly: r.validateOnly,
    verdict: r.verdict,
    messages: r.messages,
    done: Boolean(r.resolvedAt),
    resolvedBy: r.resolvedBy,
    fingerprint: r.fingerprint,
    // error is already messages[0] for a failed step (jobOutcome pushes it first), so append it
    // only when it isn't already shown — otherwise the copy duplicates it.
    copyText: [`${r.systemKey} (${r.caseNumber})`, ...r.messages, ...(r.error && !r.messages.includes(r.error) ? [r.error] : [])].filter(Boolean).join("\n"),
  }));

  const emptyText = `No ${includeResolved ? "" : "open "}outcomes${verdict || system || q ? " match the filter" : !includeClean ? " — no open errors or warnings 🎉" : " yet"}.`;

  return { q, system, verdict, includeClean, includeResolved, summary, systems, rows, emptyText };
}
