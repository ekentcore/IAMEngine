// POST /api/cases/:id/correct-user { firstName?, lastName?, displayName?, email? } — FR #88: fix the user
// this onboard created (a misspelled name, a different username/email) on every directory system the
// onboard ran, and update the case to match. Old addresses are kept as aliases. Same gate as the
// password reset (case.dispatch): it changes a live account, but deletes nothing.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { checkCorrection } from "@/lib/jobs/user-adhoc";
import { dispatchUserAdhoc } from "@/lib/cases/user-adhoc-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const checked = checkCorrection(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 422 });
  const r = await dispatchUserAdhoc(db, params.id, "correct", auditActor(_g.user, "ui"), checked.value);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
