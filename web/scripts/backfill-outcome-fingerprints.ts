// One-off: backfill RunOutcome.fingerprint for rows written before the column existed (default "").
// Without it, legacy rows never collapse and can't be marked-all "Fixed". Idempotent — re-runnable.
//   npx tsx scripts/backfill-outcome-fingerprints.ts
import { db } from "../lib/db";
import { outcomeFingerprint } from "../lib/runs/outcomes-repo";

async function main() {
  const rows = await db.runOutcome.findMany({
    where: { fingerprint: "" },
    select: { id: true, caseRequestId: true, systemKey: true, verdict: true, messages: true, error: true },
  });
  console.log(`backfilling ${rows.length} row(s)…`);
  let n = 0;
  for (const r of rows) {
    const fingerprint = outcomeFingerprint({
      caseRequestId: r.caseRequestId,
      systemKey: r.systemKey,
      verdict: r.verdict,
      messages: r.messages,
      error: r.error,
    });
    await db.runOutcome.update({ where: { id: r.id }, data: { fingerprint } });
    n++;
  }
  console.log(`done — ${n} row(s) fingerprinted.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
