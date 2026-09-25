// POST /api/cases/:id/remove-user { confirm } — FR #88: hard-delete the user this onboard created (the
// hire fell through). Dispatches one ad-hoc job per directory system the onboard ran, each APPROVAL-GATED
// with an evidence snapshot — nothing is deleted until an operator approves each step on the case.
// `confirm` must repeat the account the onboard created (removeConfirmKey) exactly: a typed guard against removing the wrong case.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { dispatchUserAdhoc } from "@/lib/cases/user-adhoc-service";
import { removeConfirmKey } from "@/lib/jobs/user-adhoc";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { confirm?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  // The key is the account the onboard actually CREATED (possibly a fallback username, not the
  // payload's), so the operator confirms the account that will really be deleted.
  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { payload: true, jobs: { select: { systemKey: true, status: true, sequence: true, result: true } } } });
  const upn = removeConfirmKey(c?.jobs ?? [], (c?.payload ?? {}) as Record<string, unknown>).trim();
  if (!upn) return NextResponse.json({ error: "the case has no email/UPN for the user, so it can't be removed from here" }, { status: 422 });
  if (typeof body.confirm !== "string" || body.confirm.trim().toLowerCase() !== upn.toLowerCase()) {
    return NextResponse.json({ error: `type the account being removed (${upn}) exactly to confirm` }, { status: 422 });
  }
  const r = await dispatchUserAdhoc(db, params.id, "remove", auditActor(_g.user, "ui"));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
