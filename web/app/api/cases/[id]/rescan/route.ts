// POST /api/cases/:id/rescan — re-pull the latest ServiceNow ticket (UM or INC) and refresh the
// case's stored intake fields. Does NOT re-plan (the operator reviews, then clicks Re-plan).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { rescanCaseIntake } from "@/lib/cases/rescan-service";
import { SnGatewayError } from "@/lib/servicenow/gateway";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.plan"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const res = await rescanCaseIntake(db, params.id, "ui");
    if (!res.ok) {
      const status = res.code === "not_found" ? 404 : res.code === "action_flip_started" ? 409 : 422;
      return NextResponse.json({ error: res.error, code: res.code }, { status });
    }
    return NextResponse.json(res);
  } catch (e) {
    const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
    return NextResponse.json({ error: `rescan failed: ${msg}` }, { status: 502 });
  }
}
