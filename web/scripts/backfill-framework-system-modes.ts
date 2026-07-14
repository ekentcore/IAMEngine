// Backfill: the "framework" systems (servicenow, case-resolution) are CHECKLIST steps, not API
// steps — no executor exists for either, and none is planned until ServiceNow write-back works.
//
//   npx tsx scripts/backfill-framework-system-modes.ts            # dry run — prints the plan, writes nothing
//   npx tsx scripts/backfill-framework-system-modes.ts --apply    # flips the rows
//
// WHY: the generator's map is already right —
//   servicenow:        { mode: "manual" }  // no write-back executor yet — manual checklist
//   "case-resolution": { mode: "manual" }  // SN write-back not available — manual
// (lib/generator/system-map.ts). It was CORRECTED to manual at some point, but the ClientSystem rows
// written before that were never backfilled, so ~130 clients still carry mode='api'.
//
// WHAT AN api ROW DOES TODAY: it plans a `pending` job, a runner claims it, finds no DISPATCH entry,
// and posts back `skipped: "no executor for <key> — manual follow-up"` (Start-IamRunner.ps1:2062).
// The case still completes (skipped is terminal-done), so nothing BREAKS — but every case burns a
// dispatch round-trip and the run report shows a misleading "skipped — no executor" line where the
// operator should be seeing a manual step they're prompted to tick off. Operators have been
// hand-flipping these jobs to succeeded, which is the tell.
//
// SCOPE: only rows whose mode is currently 'api'. Lanes, deps, secretNames and config are untouched;
// nothing is created or deleted. Idempotent — a second run finds nothing to do. Live Job rows on
// existing cases are deliberately NOT touched (they belong to real cases; the next planned case
// picks up the new mode).
import { db } from "../lib/db";

const FRAMEWORK_KEYS = ["servicenow", "case-resolution"] as const;
const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await db.clientSystem.findMany({
    where: { systemKey: { in: [...FRAMEWORK_KEYS] }, mode: "api" },
    select: { id: true, systemKey: true, clientId: true, client: { select: { slug: true, name: true } } },
    orderBy: [{ systemKey: "asc" }, { clientId: "asc" }],
  });

  if (rows.length === 0) {
    console.log("nothing to do — no framework systems are wired as api");
    return;
  }

  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(r.systemKey, (byKey.get(r.systemKey) ?? 0) + 1);
  console.log(`${APPLY ? "FLIPPING" : "would flip"} ${rows.length} ClientSystem rows api -> manual:`);
  for (const [key, n] of [...byKey].sort((a, b) => b[1] - a[1])) console.log(`  ${key.padEnd(16)} ${n} clients`);
  console.log(`\nexamples: ${rows.slice(0, 5).map((r) => `${r.client.slug}/${r.systemKey}`).join(", ")}${rows.length > 5 ? ", …" : ""}`);

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply to write.");
    return;
  }

  const result = await db.clientSystem.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { mode: "manual" },
  });

  // One audit row per client touched — the fleet-wide change has to be traceable per client, the
  // same way a hand edit on the client page would be.
  await db.auditLog.createMany({
    data: rows.map((r) => ({
      actor: "script:backfill-framework-system-modes",
      action: "client.system.mode.set",
      clientId: r.clientId,
      detail: { systemKey: r.systemKey, from: "api", to: "manual", reason: "framework system — no executor; checklist step" },
    })),
  });

  console.log(`\nflipped ${result.count} rows; wrote ${rows.length} audit entries.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
