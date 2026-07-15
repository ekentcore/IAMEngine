// POST /api/jobs/:id/reveal-reset-password — poll an ad-hoc password-reset job and reveal the
// generated password EXACTLY ONCE after it lands. While the reset is still running this returns
// { ready:false, status } (the popup polls it); on failure { ready:false, status, error }; on
// success it returns the password once and wipes it (410 after — it cannot be recalled). The audit
// records the reveal, never the value.
// Gated by case.dispatch, matching cases/[id]/reveal-password: this discloses a LIVE credential and
// consumes the one-time reveal, so it belongs to the roles that run cases — not to read-only roles
// (auditor/importer) or impersonated sessions, which guardAuth would admit.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { PASSWORD_RESET_SYSTEM_KEYS } from "@/lib/jobs/password-reset";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
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
  await recordAudit("job.password_reset.reveal", { user: _g.user, jobId: params.id, caseRequestId: job.caseRequestId, clientId: job.case.clientId });
  return NextResponse.json({ ready: true, password });
}
