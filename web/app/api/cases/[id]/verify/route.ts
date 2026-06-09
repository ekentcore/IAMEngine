// POST /api/cases/{id}/verify — "Verify everything": re-run the read-only validator (Confirm-Ctg*)
// for every automated step, so the operator can confirm the whole account ended up correct
// (nothing missed / errored / warned) without re-running any mutation. Each api job is reset to
// pending with request.validateOnly = true and the case reopened so the claim loop picks them up;
// the runner runs only the Validate lane and posts a fresh validation read-back.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { id: true, jobs: { select: { id: true, mode: true, status: true, request: true } } },
  });
  if (!c) return NextResponse.json({ error: "unknown case" }, { status: 404 });

  // Only automated (api) steps have a validator. Re-validate the terminal ones; leave in-flight jobs
  // and manual checklist items alone.
  const targets = c.jobs.filter((j) => j.mode === "api" && ["succeeded", "failed", "skipped"].includes(j.status));
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
  // Reopen the case so the claim loop (which skips failed/completed cases) dispatches the verify jobs.
  await db.caseRequest.update({ where: { id: c.id }, data: { status: "queued" } });
  await db.auditLog.create({ data: { actor: "ui", action: "case.verify", caseRequestId: c.id, detail: { steps: targets.length } } });

  return NextResponse.json({ ok: true, verifying: targets.length });
}
