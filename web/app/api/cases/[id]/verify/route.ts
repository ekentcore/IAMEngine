// POST /api/cases/{id}/verify — "Verify everything": re-run the read-only validator (Confirm-Ctg*)
// for every automated step, so the operator can confirm the whole account ended up correct
// (nothing missed / errored / warned) without re-running any mutation. Each api job is reset to
// pending with request.validateOnly = true and the case reopened so the claim loop picks them up;
// the runner runs only the Validate lane and posts a fresh validation read-back.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PASSWORD_RESET_SYSTEM_KEYS } from "@/lib/jobs/password-reset";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { id: true, jobs: { select: { id: true, systemKey: true, mode: true, status: true, request: true, error: true } } },
  });
  if (!c) return NextResponse.json({ error: "unknown case" }, { status: 404 });

  // Only automated (api) steps have a validator. Re-validate the terminal ones; leave in-flight jobs
  // and manual checklist items alone. Ad-hoc password resets are excluded: they have no validator,
  // so the sweep's no-validator pass would flip even a FAILED reset to a fresh "succeeded".
  const targets = c.jobs.filter((j) => j.mode === "api" && ["succeeded", "failed", "skipped"].includes(j.status) && !PASSWORD_RESET_SYSTEM_KEYS.includes(j.systemKey));
  if (targets.length === 0) {
    return NextResponse.json({ ok: true, verifying: 0, note: "no automated steps to verify" });
  }

  await db.$transaction(
    targets.map((j) => {
      const req = { ...((j.request ?? {}) as Record<string, unknown>), validateOnly: true };
      return db.job.update({
        where: { id: j.id },
        data: { status: "pending", assignedAgentId: null, validation: Prisma.DbNull, progress: Prisma.DbNull, error: null, finishedAt: null, request: req as Prisma.InputJsonValue },
      });
    })
  );
  // Reopen the case so the claim loop dispatches the verify jobs; clear verifiedAt so the UI shows
  // "verifying" (not a stale "Account verified" from a prior sweep) until this one finishes.
  await db.caseRequest.update({ where: { id: c.id }, data: { status: "queued", verifiedAt: null } });
  // Preserve what we cleared (prior errors on failed steps) so a verify pass doesn't erase the
  // forensic trail of why a step originally failed.
  const cleared = targets.filter((j) => j.status === "failed").map((j) => ({ jobId: j.id, error: j.error }));
  await recordAudit("case.verify", { user: _g.user, caseRequestId: c.id, detail: { steps: targets.length, clearedFailed: cleared } });

  return NextResponse.json({ ok: true, verifying: targets.length });
}
