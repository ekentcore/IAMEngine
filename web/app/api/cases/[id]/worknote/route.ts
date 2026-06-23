// POST /api/cases/:id/worknote — write the run-report summary back to the case's UM ticket as
// a ServiceNow work note. Gated: returns 409 when SN_WRITE_ENABLED is off (the POC key is
// read-only). The on-screen + downloadable report is always available regardless.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { loadRunReport } from "@/lib/cases/run-report";
import { buildResolutionNote } from "@/lib/cases/resolution-note";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { postWorkNote, writeBackEnabled } from "@/lib/servicenow/worknote";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!writeBackEnabled()) {
    return NextResponse.json({ error: "ServiceNow write-back is disabled (read-only key)" }, { status: 409 });
  }
  const rr = await loadRunReport(db, params.id);
  if (!rr) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!rr.caseNumber) return NextResponse.json({ error: "case has no ServiceNow number to write back to" }, { status: 422 });

  // Same rich note the resolution-preview modal shows, so what's posted matches what was reviewed.
  const note = buildResolutionNote(rr);

  const result = await postWorkNote(snConfigFromEnv(), rr.caseNumber, note);
  if (!result.ok) return NextResponse.json(result, { status: 502 });

  await db.auditLog.create({
    data: { actor: "ui", action: "servicenow.worknote.posted", caseRequestId: rr.caseId, detail: { caseNumber: rr.caseNumber, sysId: result.sysId } },
  });
  return NextResponse.json(result);
}
