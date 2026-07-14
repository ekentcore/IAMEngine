// One-off: re-derive the badge on cases stuck at "failed" whose only failing steps are failures the
// operator ACCEPTED ("ignore warning — mark complete"). Accepting an outcome never touched Job.status,
// and nothing re-derived the case, so the cases list read "failed" on a case whose every step reads
// green on its own page (INC0859438). deriveCaseStatus now honors accepted failures; this fixes the
// rows already written. Idempotent — re-runnable, and it only ever moves a case AWAY from a failure it
// no longer has.
//   npx tsx scripts/backfill-accepted-failure-case-status.ts          # dry run (prints, writes nothing)
//   npx tsx scripts/backfill-accepted-failure-case-status.ts --apply  # write
import { db } from "../lib/db";
import { deriveCaseStatus } from "../lib/jobs/runner-logic";
import { acceptedKeysFor } from "../lib/jobs/runner-service";

async function main() {
  const apply = process.argv.includes("--apply");
  const cases = await db.caseRequest.findMany({
    where: { status: "failed", deletedAt: null },
    select: { id: true, serviceNowCaseNumber: true },
  });
  console.log(`${cases.length} failed case(s) to check${apply ? "" : " (dry run — pass --apply to write)"}`);

  let moved = 0;
  for (const c of cases) {
    const jobs = await db.job.findMany({
      where: { caseRequestId: c.id },
      select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true },
    });
    const accepted = await acceptedKeysFor(db, c.id);
    // ONLY the accepted-failure bug. A case stuck at "failed" with no failed job left is a different
    // defect (a path that reset a job without re-deriving the case, e.g. "run this step only") — don't
    // sweep it in here, where it would look like this fix worked and quietly change what the case means.
    if (!jobs.some((j) => j.status === "failed" && accepted.has(j.systemKey))) continue;
    const status = deriveCaseStatus(
      jobs.map((j) => {
        const r = (j.request ?? {}) as { requiresApproval?: boolean; approved?: boolean };
        return {
          id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status,
          requiresApproval: Boolean(r.requiresApproval), approved: Boolean(r.approved),
          accepted: j.status === "failed" && accepted.has(j.systemKey),
        };
      })
    );
    if (status === "failed") continue;
    const why = jobs.filter((j) => j.status === "failed" && accepted.has(j.systemKey)).map((j) => j.systemKey);
    console.log(`  ${c.serviceNowCaseNumber ?? c.id}: failed -> ${status}  (accepted: ${why.join(", ") || "none"})`);
    if (apply) await db.caseRequest.update({ where: { id: c.id }, data: { status } });
    moved++;
  }
  console.log(apply ? `updated ${moved} case(s)` : `${moved} case(s) would change`);
  await db.$disconnect();
}

main();
