// POST /api/jobs/:id/reset-password — "Generate random password" on a case's AD/M365/Google line
// (INC0855142): dispatch a single ad-hoc job that sets a fresh app-generated password on the account
// (force change at next sign-in). The value lives on Job.oneTimePassword until the operator reveals
// it ONCE via reveal-reset-password (then it's wiped); it's injected into the runner config at claim
// and never appears in results, work notes, or audit. singleRun: claimable even on a completed/paused
// case and records without cascading into the case status.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { generateInitialPassword } from "@/lib/auth/password";
import { PASSWORD_RESET_KEY } from "@/lib/jobs/password-reset";
import { insertStepSequence } from "@/lib/jobs/adhoc";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  // Optional body: { requireChangeAtSignIn?: boolean } — the operator's per-reset choice (FR #14).
  // Default true; explicitly false means "I still have to log in as this user (equipment setup)".
  let body: { requireChangeAtSignIn?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body = defaults */ }
  const requireChangeAtSignIn = body.requireChangeAtSignIn !== false;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const src = await db.job.findUnique({
    where: { id: params.id },
    select: { systemKey: true, caseRequestId: true, request: true, case: { select: { clientId: true, deletedAt: true, dryRun: true } } },
  });
  if (!src || src.case.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });
  const resetKey = PASSWORD_RESET_KEY[src.systemKey];
  if (!resetKey) return NextResponse.json({ error: `password reset isn't supported for ${src.systemKey}` }, { status: 422 });
  // Dry-run is authoritative at claim time — the reset would run -WhatIf, "succeed", and reveal a
  // password that was never set. Refuse instead.
  if (src.case.dryRun) return NextResponse.json({ error: "this case is in dry-run mode — the reset wouldn't actually change the password; turn off dry run first" }, { status: 409 });

  // One at a time per system: reuse an in-flight reset instead of stacking a second password change.
  const inflight = await db.job.findFirst({
    where: { caseRequestId: src.caseRequestId, systemKey: resetKey, status: { in: ["pending", "dispatched", "running"] } },
    select: { id: true },
  });
  if (inflight) return NextResponse.json({ ok: true, jobId: inflight.id, reused: true });

  // Ride the source line's request so credential brokering + tenant/identity config just work; the
  // initial-password knobs are dropped so the executor can't confuse this with an onboard.
  const srcReq = (src.request ?? {}) as Record<string, unknown>;
  const { initialPassword: _ip, initialPasswordSecret: _ips, ...config } = (srcReq.config ?? {}) as Record<string, unknown>;
  config.requireChangeAtSignIn = requireChangeAtSignIn;
  // Insert ABOVE the case-resolution step (which must stay last) rather than appending at the end.
  const job = await db.$transaction(async (tx) => {
    const sequence = await insertStepSequence(tx, src.caseRequestId);
    return tx.job.create({
      data: {
        caseRequestId: src.caseRequestId, systemKey: resetKey, mode: "api", sequence,
        status: "pending", singleRun: true, oneTimePassword: generateInitialPassword(),
        request: { secretNames: srcReq.secretNames ?? [], config, dependsOn: [], requiresApproval: false, captureEvidence: false } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });
  // The audit records the dispatch, never the value.
  await recordAudit("job.password_reset.dispatch", { user: _g.user, jobId: job.id, caseRequestId: src.caseRequestId, clientId: src.case.clientId, detail: { systemKey: resetKey, fromLine: src.systemKey, requireChangeAtSignIn } });
  return NextResponse.json({ ok: true, jobId: job.id });
}
