// POST /api/cases/{id}/verify — "Verify everything": re-run the read-only validator (Confirm-Ctg*)
// for every automated step, so the operator can confirm the whole account ended up correct
// (nothing missed / errored / warned) without re-running any mutation. Each api job is reset to
// pending with request.validateOnly = true and the case reopened so the claim loop picks them up;
// the runner runs only the Validate lane and posts a fresh validation read-back.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { verifyCase } from "@/lib/cases/actions";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  // The target selection (terminal, non-ad-hoc api steps), the validate-only reset, the reopen, and
  // the audit all live in verifyCase (shared with the bulk route).
  const r = await verifyCase(db, params.id, _g.user);
  if (!r.ok) return NextResponse.json({ error: "unknown case" }, { status: 404 });
  return NextResponse.json({ ok: true, ...r.result });
}
