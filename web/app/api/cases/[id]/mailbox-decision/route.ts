// POST /api/cases/:id/mailbox-decision { policy: "convert" | "remove" | "keep" }
//
// The operator's answer to DECISION_NEEDED:mailbox_not_converted — a mailbox UNDER the cap that
// nothing converted to shared. Most often that is a client whose profile configures no conversion at
// ALL (Easterseals: ClientSystem(exchange).config.offboard is null, so Coretelligent.Exchange skips
// its convert block silently), which made the runner's old "convert the mailbox, then re-run this
// step" advice impossible to act on: every re-run reproduced the same warning and the seat was never
// reclaimed. The three answers here are the ones that actually resolve it.
//
// This is ONE endpoint rather than the pickers' usual PATCH-then-POST-rerun pair, because `convert`
// has to re-queue TWO jobs in a specific ORDER and that invariant must not live in a browser:
//
//   exchange MUST return to `pending` BEFORE entra does.
//
// entra's request.dependsOn is ["m365","exchange"], and blockingJobs (jobs/runner-logic.ts) only holds
// a job whose api dependency is not succeeded/skipped/accepted. So while exchange is still `succeeded`
// from its previous run, a re-queued entra is immediately claimable — a runner polling inside that
// window would re-run entra against the OLD exchange result (mailboxConverted still false) and simply
// ask the question again. Doing both here, exchange first, closes the window.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit, auditActor } from "@/lib/auth/audit";
import { requeueJob } from "@/lib/jobs/requeue";
import { planMailboxDecision, isMailboxPolicy, MAILBOX_POLICIES } from "@/lib/cases/mailbox-decision";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch"); if (g.res) return g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { policy?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!isMailboxPolicy(body.policy)) {
    return NextResponse.json({ error: `policy must be one of: ${MAILBOX_POLICIES.join(", ")}` }, { status: 422 });
  }

  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { jobs: { where: { systemKey: { in: ["m365", "entra", "exchange"] } }, select: { id: true, systemKey: true, request: true } } },
  });
  if (!c) return NextResponse.json({ error: "case not found" }, { status: 404 });

  // WHAT to do — including the re-queue ORDER, which is the part that is easy to break and invisible
  // when broken — is decided in lib/cases/mailbox-decision and pinned by its tests. This handler only
  // executes the plan.
  const plan = planMailboxDecision(body.policy, c.jobs);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: plan.status });

  const byId = new Map(c.jobs.map((j) => [j.id, j]));
  for (const w of plan.writes) {
    for (const id of w.jobIds) {
      const j = byId.get(id);
      if (!j) continue;
      const r = { ...((j.request ?? {}) as Record<string, unknown>) };
      r.config = { ...((r.config ?? {}) as Record<string, unknown>), [w.key]: w.value };
      await db.job.update({ where: { id }, data: { request: r as Prisma.InputJsonValue } });
    }
  }

  // Audited HERE, not after the re-queues: the answer is already durable on the jobs at this point, so
  // a re-queue that then fails must not leave a recorded decision with no audit row explaining where
  // it came from. The re-queue is how the answer gets ACTED on; the audit is of the answer itself.
  await recordAudit("case.mailbox_decision", { user: g.user, caseRequestId: params.id, detail: { policy: body.policy } });

  // Writes land BEFORE any re-queue: requeueJob re-reads the row (it only strips validateOnly and
  // autoRetry), so the config above survives. Stops at the first refusal and reports it rather than
  // half-queuing the pair and reporting success — the operator retries from the step's own Re-run.
  for (const id of plan.requeue) {
    const out = await requeueJob(db, id, auditActor(g.user, "ui"));
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  }

  return NextResponse.json({ ok: true, policy: body.policy });
}
