// POST /api/cases/:id/offboard-target { upn, displayName?, samAccountName?, mail? }
//
// The operator picks WHO to offboard, after an executor found the ticket's name ambiguous (several
// matches) or unresolvable (none). The pick is written to the CASE payload — not a job config —
// because every one of the offboard executors resolves the leaver from there, so one choice unblocks
// all of them. Then the hold is released and EVERY automated step is re-queued from the top.
//
// Re-running the whole case (rather than just the blocked step) is deliberate: a step that ran BEFORE
// the pick may have quietly no-op'd against an identity it couldn't resolve and still reported "ok —
// user not found", so only a full re-run guarantees nothing was missed. Executors are idempotent by
// contract, so re-running a step that already did its work is safe.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requeueJob } from "@/lib/jobs/requeue";
import { recordAudit, actorLabel } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch"); if (g.res) return g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { upn?: unknown; displayName?: unknown; samAccountName?: unknown; mail?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const upn = typeof body.upn === "string" ? body.upn.trim() : "";
  // An offboard target that isn't an email/UPN is not an identity — the executors match on one, and a
  // bare name is exactly the ambiguity that got us here.
  if (!upn || !upn.includes("@")) {
    return NextResponse.json({ error: "pick a user, or enter their UPN / email address" }, { status: 422 });
  }

  const kase = await db.caseRequest.findUnique({ where: { id: params.id }, select: { id: true, action: true, payload: true, clientId: true } });
  if (!kase) return NextResponse.json({ error: "unknown case" }, { status: 404 });
  if (kase.action !== "offboard") return NextResponse.json({ error: "an offboard target applies to an offboard case" }, { status: 422 });

  // Write the identity every executor reads. userToOffboard stays as the ticket's original name (it is
  // what the case is ABOUT); the resolved fields are what the modules now match on.
  const payload = { ...((kase.payload ?? {}) as Record<string, unknown>) };
  payload.userPrincipalName = upn;
  payload.email = upn;
  payload.workEmail = upn;
  if (typeof body.displayName === "string" && body.displayName.trim()) payload.displayName = body.displayName.trim();
  // AD matches on samAccountName when it has one. Prefer the real value from the directory; fall back
  // to the UPN's local part (what deriveIdentity would compute) rather than leaving a stale one.
  const sam = typeof body.samAccountName === "string" && body.samAccountName.trim()
    ? body.samAccountName.trim()
    : (upn.split("@")[0] ?? "").slice(0, 20);
  if (sam) payload.samAccountName = sam;
  const fieldSource = { ...((payload.fieldSource ?? {}) as Record<string, string>) };
  for (const k of ["userPrincipalName", "email", "displayName", "samAccountName"]) fieldSource[k] = "operator";
  payload.fieldSource = fieldSource;

  await db.caseRequest.update({
    where: { id: kase.id },
    // Release the hold the ambiguous result put on the case (recordResult set needs_info).
    data: { payload: payload as Prisma.InputJsonValue, pausedAt: null, pausedReason: null, verifiedAt: null },
  });

  // Re-run every automated step from the top. A step that reported "ok — user not found" is
  // `succeeded`, so requeueing only the failures would leave that system silently un-offboarded.
  const jobs = await db.job.findMany({ where: { caseRequestId: kase.id, mode: "api" }, select: { id: true } });
  const actor = actorLabel(g.user, "ui:offboard-target");
  let requeued = 0;
  const skipped: string[] = [];
  for (const j of jobs) {
    const out = await requeueJob(db, j.id, actor);
    if (out.ok) requeued++;
    else skipped.push(j.id); // e.g. a step still running — it will pick up the new payload on its own re-run
  }

  await recordAudit("case.offboard_target.select", {
    user: g.user,
    caseRequestId: kase.id,
    detail: { upn, displayName: payload.displayName ?? null, samAccountName: sam || null, requeued, skipped: skipped.length },
  });

  return NextResponse.json({ ok: true, upn, requeued, skipped: skipped.length });
}
