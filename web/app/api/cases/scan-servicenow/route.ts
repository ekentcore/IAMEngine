// POST /api/cases/scan-servicenow — check every open (non-completed, non-trashed) case that has a
// ServiceNow number against the live ticket state, in one batched `numberIN…` query per 50 cases.
// Read-only: returns the cases whose ticket is affirmatively resolved/closed so the operator can
// confirm marking them completed (that happens via POST /api/cases/{id}/complete). Cancelled /
// Closed Incomplete tickets are reported separately — those closures mean the work did NOT happen,
// so they must not be auto-completed.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, clientIdWhere } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchTaskStates, classifyTaskState } from "@/lib/servicenow/task-state";
import type { ScanHit, ScanResult } from "@/lib/cases/sn-completion";

export const dynamic = "force-dynamic";

export async function POST() {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  const config = snConfigFromEnv();
  if (!config.instanceUrl || !config.username) {
    return NextResponse.json({ error: "ServiceNow is not configured (SN_INSTANCE_URL / SN_USER)" }, { status: 409 });
  }

  const scope = await currentClientScope(db);
  const cases = await db.caseRequest.findMany({
    where: { deletedAt: null, status: { not: "completed" }, serviceNowCaseNumber: { not: null }, clientId: clientIdWhere(scope) },
    select: { id: true, subject: true, status: true, serviceNowCaseNumber: true, client: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });

  const resolved: ScanHit[] = [];
  const cancelled: ScanHit[] = [];
  const errors: ScanResult["errors"] = [];
  try {
    const states = await fetchTaskStates(config, cases.map((c) => c.serviceNowCaseNumber!));
    for (const c of cases) {
      const state = states.get(c.serviceNowCaseNumber!);
      if (!state) continue; // number not found in SN — nothing to act on
      const cls = classifyTaskState(state.state);
      if (cls === "open") continue;
      const hit: ScanHit = { id: c.id, caseNumber: c.serviceNowCaseNumber!, subject: c.subject, clientName: c.client.name, status: c.status, snState: state.state };
      (cls === "done" ? resolved : cancelled).push(hit);
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const body: ScanResult = { scanned: cases.length, resolved, cancelled, errors };
  return NextResponse.json(body);
}
