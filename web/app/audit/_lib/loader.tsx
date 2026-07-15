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

// Keys rendered by hand (or too bulky to dump inline) — kept out of the generic key=value pass.
const SPECIAL_KEYS = new Set(["summary", "diff"]);

// The one-line cell. A row carrying a `summary` (a runbook edit) leads with it; everything else
// falls back to the generic key=value dump.
export function fmtDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  const rest = Object.entries(d)
    .filter(([k]) => !SPECIAL_KEYS.has(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
  return typeof d.summary === "string" ? [d.summary, rest].filter(Boolean).join(" — ") : rest;
}

type RunbookDiffDetail = {
  added?: Array<{ title: string; systemKey: string | null; steps: number }>;
  removed?: Array<{ title: string; systemKey: string | null; steps: number }>;
  changed?: Array<{
    title: string;
    titleFrom?: string;
    titleTo?: string;
    statusFrom?: string;
    statusTo?: string;
    steps?: { added: string[]; removed: string[] };
  }>;
  reordered?: Array<{ title: string; from: number; to: number }>;
};

// The hover/expanded view. A runbook edit's diff is spelled out line by line — "someone re-saved the
// runbook" is useless; "Jane deleted the Spanning section" is the thing you actually need to see.
export function fmtDetailLong(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof d.summary === "string") lines.push(d.summary);

  const diff = d.diff as RunbookDiffDetail | undefined;
  if (diff && typeof diff === "object") {
    for (const s of diff.added ?? []) lines.push(`+ added section "${s.title}" (${s.steps} step${s.steps === 1 ? "" : "s"})`);
    for (const s of diff.removed ?? []) lines.push(`− removed section "${s.title}" (${s.steps} step${s.steps === 1 ? "" : "s"})`);
    for (const c of diff.changed ?? []) {
      if (c.titleFrom && c.titleTo) lines.push(`~ renamed "${c.titleFrom}" → "${c.titleTo}"`);
      if (c.statusFrom && c.statusTo) lines.push(`~ "${c.title}" status ${c.statusFrom} → ${c.statusTo}`);
      for (const step of c.steps?.added ?? []) lines.push(`  + "${c.title}": added step "${step}"`);
      for (const step of c.steps?.removed ?? []) lines.push(`  − "${c.title}": removed step "${step}"`);
    }
    for (const r of diff.reordered ?? []) lines.push(`~ moved "${r.title}" (${r.from} → ${r.to})`);
  }

  const rest = Object.entries(d)
    .filter(([k]) => !SPECIAL_KEYS.has(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
  if (rest) lines.push(rest);
  return lines.join("\n");
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
