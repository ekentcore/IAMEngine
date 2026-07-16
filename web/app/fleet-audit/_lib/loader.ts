// Shared page-data loader for /audits. Auth, client scope, the run lookup and the row view-models
// live here once so presentation stays out of the data path (see the v1/v2 loader-drift rule).
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { can } from "@/lib/auth/permissions";
import { latestRun, latestFinished, type AuditRun } from "@/lib/audits/audit-runs";
import { pivotByPermission, leakVerdict, type PermissionRow, type LeakRow, type PermissionPivot } from "@/lib/audits/m365-audit";
import { GRAPH_APP_ROLE_IDS, GRAPH_RESOURCE_APP_ID } from "@/lib/secrets/graph-caps";

export type AuditsSearchParams = { tab?: string };

export type RunMeta = { status: string; startedAt: string; finishedAt: string | null; startedBy: string | null; scanned: number; total: number; error: string | null } | null;

export type AuditsPageData = {
  tab: "permissions" | "leaked_seats";
  // The run whose findings are shown (the last FINISHED one)…
  shown: RunMeta;
  // …and the newest run of any state, which is what the progress line and the button key off.
  live: RunMeta;
  permissions: { pivot: PermissionPivot[]; rows: PermissionRow[]; unverified: PermissionRow[]; noCred: PermissionRow[] };
  leaks: { rows: (LeakRow & { verdict: string })[]; shared: number; notShared: number; unknown: number };
  grantHelp: { resourceAppId: string; roleIds: Record<string, string> };
};

function meta(r: AuditRun | null): RunMeta {
  if (!r) return null;
  return {
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    startedBy: r.startedBy,
    scanned: r.scanned,
    total: r.total,
    error: r.error,
  };
}

// Returns null for an unauthenticated or unpermitted request (the layout redirects to /login).
export async function loadAuditsPage(searchParams: AuditsSearchParams): Promise<AuditsPageData | null> {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me) return null;
    // Reading every client's credential state is the same capability as wiring one.
    if (!can(me.role, "client.edit_secrets")) return null;
  }
  const tab = searchParams.tab === "leaked_seats" ? "leaked_seats" : "permissions";
  const kind = tab;

  const [shownRun, liveRun, scope] = await Promise.all([latestFinished(db, kind), latestRun(db, kind), currentClientScope(db)]);

  // A sweep visits every client, but a restricted operator must only ever SEE their own. Filter the
  // stored findings on read rather than at scan time, so one run serves every viewer honestly.
  const findings = (shownRun?.findings ?? []) as unknown[];
  const visible = findings.filter((f) => scopeAllows(scope, (f as { clientId?: string }).clientId ?? null));

  let permissions: AuditsPageData["permissions"] = { pivot: [], rows: [], unverified: [], noCred: [] };
  let leaks: AuditsPageData["leaks"] = { rows: [], shared: 0, notShared: 0, unknown: 0 };

  if (tab === "permissions") {
    const rows = visible as PermissionRow[];
    permissions = {
      pivot: pivotByPermission(rows),
      rows,
      unverified: rows.filter((r) => r.status === "unverified"),
      noCred: rows.filter((r) => r.status === "cred-bad" || r.status === "no-cred"),
    };
  } else {
    const rows = (visible as LeakRow[]).map((r) => ({ ...r, verdict: leakVerdict(r.mailbox) }));
    leaks = {
      rows,
      shared: rows.filter((r) => r.mailbox === "shared").length,
      notShared: rows.filter((r) => r.mailbox === "not-shared").length,
      unknown: rows.filter((r) => r.mailbox === "unknown").length,
    };
  }

  return {
    tab,
    shown: meta(shownRun),
    live: meta(liveRun),
    permissions,
    leaks,
    grantHelp: { resourceAppId: GRAPH_RESOURCE_APP_ID, roleIds: GRAPH_APP_ROLE_IDS },
  };
}
