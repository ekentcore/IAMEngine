// POST /api/jobs/:id/stop — operator aborts an in-flight (or queued) step that looks wedged. Marks the
// job failed so the case stops waiting on it; a late result the runner posts is rejected (409), so the
// stop holds. The runner's own process isn't killed remotely (that's the watchdog's job) — this is the
// app-side "stop waiting + let me re-plan/skip".
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { actorLabel } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const out = await makeRunnerService(db).stopJob(params.id, actorLabel(_g.user, "ui"));
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
