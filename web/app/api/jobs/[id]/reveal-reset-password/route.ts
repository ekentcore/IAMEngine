// POST /api/jobs/:id/reveal-reset-password — poll an ad-hoc password-reset job and reveal the
// generated password EXACTLY ONCE after it lands. While the reset is still running this returns
// { ready:false, status } (the popup polls it); on failure { ready:false, status, error }; on
// success it returns the password once and wipes it (410 after — it cannot be recalled). The audit
// records the reveal, never the value.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { actorLabel } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { PASSWORD_RESET_SYSTEM_KEYS } from "@/lib/jobs/password-reset";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = await db.job.findUnique({
    where: { id: params.id },
    select: { systemKey: true, status: true, error: true, oneTimePassword: true, caseRequestId: true, case: { select: { clientId: true } } },
  });
  if (!job || !PASSWORD_RESET_SYSTEM_KEYS.includes(job.systemKey)) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (["pending", "dispatched", "running"].includes(job.status)) {
    return NextResponse.json({ ready: false, status: job.status });
  }
  if (job.status !== "succeeded") {
    return NextResponse.json({ ready: false, status: job.status, error: job.error ?? null });
  }
  if (!job.oneTimePassword) {
    return NextResponse.json({ error: "already revealed — a password is shown exactly once and can't be recalled" }, { status: 410 });
  }

  // Atomic claim of the one-time reveal: only the caller whose conditional wipe actually flips the
  // column gets the value — two concurrent pollers (two tabs, popup + line button) can't both win.
  const password = job.oneTimePassword;
  const claimed = await db.job.updateMany({ where: { id: params.id, oneTimePassword: password }, data: { oneTimePassword: null } });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "already revealed — a password is shown exactly once and can't be recalled" }, { status: 410 });
  }
  await db.auditLog.create({ data: { actor: actorLabel(_g.user, "ui"), action: "job.password_reset.reveal", jobId: params.id, caseRequestId: job.caseRequestId, clientId: job.case.clientId } });
  return NextResponse.json({ ready: true, password });
}
