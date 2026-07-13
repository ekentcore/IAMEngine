// Shared page-data loader for /runs and /runs/v2. Both variants render the SAME data —
// only presentation differs — so the auth check, scope, queries and the RunLogTable row
// view-models live here once. Adding a field here reaches both pages; adding it in a page
// file is the drift that broke features on other v2 pages.
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { currentClientScope } from "@/lib/auth/client-scope";
import { listOutcomes, groupOutcomes, moduleIssueSummary, outcomeSystems } from "@/lib/runs/outcomes-repo";
import type { FixProposal } from "@/lib/fixes/fix-tasks";
import type { RunLogRow } from "../_components/run-log-table";
import type { CredFailure } from "@/lib/jobs/cred-failure";
import type { FixTaskInfo } from "../_components/claude-fix";

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
    credFailure: (r.credFailure ?? null) as CredFailure | null,
    done: Boolean(r.resolvedAt),
    resolvedBy: r.resolvedBy,
    fingerprint: r.fingerprint,
    // error is already messages[0] for a failed step (jobOutcome pushes it first), so append it
    // only when it isn't already shown — otherwise the copy duplicates it.
    copyText: [
      `${r.systemKey} (${r.caseNumber})`,
      ...r.messages,
      ...(r.error && !r.messages.includes(r.error) ? [r.error] : []),
      // machine-usable line for scripted remediation
      ...(r.credFailure ? [`credFailure: ${JSON.stringify(r.credFailure)}`] : []),
    ].filter(Boolean).join("\n"),
  }));

  const emptyText = `No ${includeResolved ? "" : "open "}outcomes${verdict || system || q ? " match the filter" : !includeClean ? " — no open errors or warnings 🎉" : " yet"}.`;

  // The NEWEST fix-lane task per visible fingerprint seeds the client hook, so a proposal survives
  // reloads and auto-filed tasks show up without a click. Considering only the newest (not the
  // newest non-dismissed) matters: after a line's latest task is dismissed, an OLDER failed/proposed
  // task must not resurface its chip — and this agrees with GET /api/fix-tasks, which the 5s poll
  // uses and which also returns the newest task. A dismissed newest → seed nothing for that line.
  const fingerprints = [...new Set(rows.map((r) => r.fingerprint).filter(Boolean))];
  const initialFixTasks: Record<string, FixTaskInfo> = {};
  if (fingerprints.length > 0) {
    const fixTasks = await db.fixTask.findMany({
      where: { fingerprint: { in: fingerprints } },
      orderBy: { createdAt: "desc" },
      select: { id: true, fingerprint: true, status: true, prUrl: true, log: true, proposal: true, provider: true },
    });
    const seen = new Set<string>();
    for (const t of fixTasks) {
      if (seen.has(t.fingerprint)) continue; // newest wins (rows are createdAt desc)
      seen.add(t.fingerprint);
      if (t.status === "dismissed") continue; // newest is dismissed → the line is quiet
      const log = t.log && t.log.length > 4000 ? t.log.slice(-4000) : t.log;
      initialFixTasks[t.fingerprint] = { id: t.id, status: t.status, prUrl: t.prUrl, log, proposal: t.proposal as FixProposal | null, provider: t.provider };
    }
  }

  return { q, system, verdict, includeClean, includeResolved, summary, systems, rows, emptyText, initialFixTasks };
}
