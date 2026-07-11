// POST /api/cases/bulk { ids: string[], action: "dispatch"|"pause"|"cancel"|"verify" } — apply one
// run-control action across selected cases. Mirrors /api/clients/hard-refresh: ONE guard, validate +
// dedupe + cap the ids, then delegate to a shared lib helper (runBulkCaseAction). All four actions are
// case.dispatch — "dispatch" only UNPAUSES (the runner still holds any requiresApproval job), so it
// can't skip an approval gate. Out-of-scope or state-invalid cases are skipped with a reason, never
// erroring the batch.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { isBulkAction, runBulkCaseAction } from "@/lib/cases/actions";

export const dynamic = "force-dynamic";

const MAX = 100; // bound the serial per-case work so one request can't run unbounded

export async function POST(req: Request) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  let body: { ids?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (!isBulkAction(body.action)) {
    return NextResponse.json({ error: "action must be one of dispatch|pause|cancel|verify" }, { status: 422 });
  }
  const action = body.action;
  if (!Array.isArray(body.ids) || body.ids.some((s) => typeof s !== "string")) {
    return NextResponse.json({ error: "ids[] (strings) is required" }, { status: 422 });
  }
  const ids = [...new Set((body.ids as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, MAX);
  if (ids.length === 0) return NextResponse.json({ error: "no ids given" }, { status: 422 });

  // Scope computed ONCE (not per id) — the helper filters each case against it.
  const scope = await currentClientScope(db);
  const results = await runBulkCaseAction(db, action, ids, _g.user, scope);

  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  await recordAudit(`case.bulk.${action}`, { user: _g.user, detail: { action, requested: ids.length, ok, skipped } });
  return NextResponse.json({ results, ok, failed: results.length - ok });
}
