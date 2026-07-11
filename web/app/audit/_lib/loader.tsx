// Shared page-data loader for /audit and /audit/v2 — gate, query, batch target resolution, and
// the target()/fmtDetail() renderers live here once so the variants can't drift. The query shape
// is the v2 superset: `action` accepts a comma-separated list (v1's single select is the
// degenerate case) and `user` narrows to one operator's rows. This is a .tsx because target()
// returns JSX.
import { redirect } from "next/navigation";
import Link from "next/link";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { currentClientScope } from "@/lib/auth/client-scope";
import { can } from "@/lib/auth/permissions";

export const AUDIT_LIMIT = 250;

export type AuditSearchParams = { q?: string; action?: string; days?: string; user?: string };

export function fmtDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  return Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

export async function loadAuditPage(searchParams: AuditSearchParams) {
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
  }

  const q = (searchParams.q ?? "").trim();
  const actionParam = (searchParams.action ?? "").trim(); // comma-separated (multi-select)
  const actions = actionParam.split(",").map((s) => s.trim()).filter(Boolean);
  const userId = (searchParams.user ?? "").trim();
  const days = searchParams.days === "all" ? null : Number(searchParams.days ?? 7);

  const where: Prisma.AuditLogWhereInput = {};
  if (days && Number.isFinite(days)) where.at = { gte: new Date(Date.now() - days * 86_400_000) };
  if (actions.length) where.action = { in: actions }; // OR across the selected actions
  if (userId) where.userId = userId; // logs for just this operator
  if (q) where.OR = [{ action: { contains: q, mode: "insensitive" } }, { actor: { contains: q, mode: "insensitive" } }];
  // Scope-gate to the operator's visible clients. Global rows (no clientId — logins, user admin,
  // system tasks) stay visible; rows pinned to a hidden client are filtered out.
  const scope = await currentClientScope(db);
  if (scope !== null) where.AND = [{ OR: [{ clientId: null }, { clientId: { in: scope } }] }];

  const [rows, actionGroups, focusUser] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { at: "desc" }, take: AUDIT_LIMIT, include: { user: { select: { email: true, name: true } } } }),
    db.auditLog.groupBy({ by: ["action"], _count: true, orderBy: { _count: { action: "desc" } }, take: 60 }),
    userId ? db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }) : Promise.resolve(null),
  ]);

  // Batch-resolve referenced clients/cases/jobs for readable targets (no N+1).
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

  return {
    rows,
    // Count-ordered raw action names (v1's dropdown order); v2 re-sorts by English label.
    actionOptions: actionGroups.map((a) => a.action),
    focusUser,
    q,
    actionParam,
    userId,
    target,
  };
}
