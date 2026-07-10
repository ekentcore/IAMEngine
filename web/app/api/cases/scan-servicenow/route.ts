// POST /api/cases/scan-servicenow — check every open (non-completed, non-trashed) case that has a
// ServiceNow number against the live ticket state. Read-only: returns the cases whose ticket is
// affirmatively resolved/closed so the operator can confirm marking them completed (that happens
// via POST /api/cases/{id}/complete). Cancelled / Closed Incomplete tickets are reported separately
// — those closures mean the work did NOT happen, so they must not be auto-completed.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, clientIdWhere } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchTaskState, classifyTaskState } from "@/lib/servicenow/task-state";

export const dynamic = "force-dynamic";

const CONCURRENCY = 4; // polite parallelism against the SN table API

type ScanHit = { id: string; caseNumber: string; subject: string | null; clientName: string; status: string; snState: string };

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
  const errors: { caseNumber: string; error: string }[] = [];
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    await Promise.all(
      cases.slice(i, i + CONCURRENCY).map(async (c) => {
        const caseNumber = c.serviceNowCaseNumber!;
        try {
          const state = await fetchTaskState(config, caseNumber);
          if (!state) return; // number not found in SN — nothing to act on
          const cls = classifyTaskState(state.state);
          if (cls === "open") return;
          const hit: ScanHit = { id: c.id, caseNumber, subject: c.subject, clientName: c.client.name, status: c.status, snState: state.state };
          (cls === "done" ? resolved : cancelled).push(hit);
        } catch (e) {
          errors.push({ caseNumber, error: e instanceof Error ? e.message : String(e) });
        }
      })
    );
  }

  return NextResponse.json({ scanned: cases.length, resolved, cancelled, errors });
}
