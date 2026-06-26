// Audit review v2: same data as /audit, but actions read in plain English, the action dropdown is
// alphabetical, and an optional ?user=<id> filter shows the log for just that operator (linked from
// /users/v2). Reached via the Version 2 toggle (middleware routes /audit -> /audit/v2 when on).
import { redirect } from "next/navigation";
import Link from "next/link";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { currentClientScope } from "@/lib/auth/client-scope";
import { can } from "@/lib/auth/permissions";
import { actionLabel } from "@/lib/audit/action-labels";
import { AuditFilters } from "../_components/audit-filters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit (v2)" };

const LIMIT = 250;

function fmtDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  return Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

export default async function AuditV2Page({ searchParams }: { searchParams: { q?: string; action?: string; days?: string; user?: string } }) {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
  }

  const q = (searchParams.q ?? "").trim();
  const action = (searchParams.action ?? "").trim();
  const userId = (searchParams.user ?? "").trim();
  const days = searchParams.days === "all" ? null : Number(searchParams.days ?? 7);

  const where: Prisma.AuditLogWhereInput = {};
  if (days && Number.isFinite(days)) where.at = { gte: new Date(Date.now() - days * 86_400_000) };
  if (action) where.action = action;
  if (userId) where.userId = userId; // logs for just this operator
  if (q) where.OR = [{ action: { contains: q, mode: "insensitive" } }, { actor: { contains: q, mode: "insensitive" } }];
  const scope = await currentClientScope(db);
  if (scope !== null) where.AND = [{ OR: [{ clientId: null }, { clientId: { in: scope } }] }];

  const [rows, actionGroups, focusUser] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { at: "desc" }, take: LIMIT, include: { user: { select: { email: true, name: true } } } }),
    db.auditLog.groupBy({ by: ["action"], _count: true, orderBy: { _count: { action: "desc" } }, take: 60 }),
    userId ? db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }) : Promise.resolve(null),
  ]);

  const clientIds = [...new Set(rows.map((r) => r.clientId).filter(Boolean) as string[])];
  const caseIds = [...new Set(rows.map((r) => r.caseRequestId).filter(Boolean) as string[])];
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter(Boolean) as string[])];
  const [clients, cases, jobs] = await Promise.all([
    clientIds.length ? db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, slug: true } }) : [],
    caseIds.length ? db.caseRequest.findMany({ where: { id: { in: caseIds } }, select: { id: true, serviceNowCaseNumber: true, subject: true } }) : [],
    jobIds.length ? db.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, systemKey: true, caseRequestId: true } }) : [],
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  function target(r: (typeof rows)[number]): React.ReactNode {
    if (r.caseRequestId) {
      const c = caseById.get(r.caseRequestId);
      return <Link href={`/cases/${r.caseRequestId}`}>{c?.serviceNowCaseNumber ?? c?.subject ?? "case"}</Link>;
    }
    if (r.jobId) {
      const j = jobById.get(r.jobId);
      return j ? <Link href={`/cases/${j.caseRequestId}`}>{j.systemKey} step</Link> : <span className="muted">job</span>;
    }
    if (r.clientId) {
      const c = clientById.get(r.clientId);
      return c ? <Link href={`/clients/${c.slug}`}>{c.name}</Link> : <span className="muted">client</span>;
    }
    return <span className="muted">—</span>;
  }

  // Alphabetical by the English label.
  const sortedActions = actionGroups.map((a) => a.action).sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
  const focusLabel = focusUser ? (focusUser.name || focusUser.email) : null;

  return (
    <main>
      <h1>Audit log <span className="note">(v2)</span></h1>
      <p className="note">{rows.length === LIMIT ? `Most recent ${LIMIT} matching events` : `${rows.length} matching events`} — who did what, when. Filter below.</p>
      {focusLabel && (
        <p className="note" style={{ marginTop: 4 }}>
          Showing the log for <b>{focusLabel}</b>. <Link href="/audit/v2">Show all</Link>
        </p>
      )}
      <AuditFilters
        actions={sortedActions}
        current={{ q, action, days: searchParams.days ?? "7" }}
        basePath="/audit/v2"
        label={actionLabel}
        extra={userId ? { user: userId } : {}}
      />
      <table style={{ marginTop: "1rem" }}>
        <thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 190 }}>Who</th><th style={{ width: 220 }}>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="note tnum" style={{ whiteSpace: "nowrap" }}>{r.at.toLocaleString()}</td>
              <td>{r.user ? <span title={r.user.email}>{r.user.name || r.user.email}</span> : <span className="muted">{r.actor}</span>}</td>
              <td title={r.action}>{actionLabel(r.action)}</td>
              <td>{target(r)}</td>
              <td className="note" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fmtDetail(r.detail)}>{fmtDetail(r.detail)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="empty-state">No events match these filters.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
