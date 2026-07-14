// Backfill: systems wired as `api` that have NO credential and NO modeled behaviour are CHECKLIST
// steps, not API steps.
//
//   npx tsx scripts/backfill-uncredentialed-system-modes.ts            # dry run — prints the plan, writes nothing
//   npx tsx scripts/backfill-uncredentialed-system-modes.ts --apply    # flips the rows
//
// WHY: sharepoint / mdm / printix / archive / notion are modelled `api` on 27 client-systems, but not
// one of them has a secret wired, and their configs are empty ({onboard: null, offboard: null}). There
// is nothing to authenticate with and no specified behaviour — an executor would have to invent both.
// A human does these steps today.
//
// WHAT AN api ROW DOES TODAY: it plans a `pending` job, a runner claims it, finds no $DISPATCH entry,
// and posts back `skipped: "no executor for <key> — manual follow-up"`. `skipped` is terminal-done, so
// the case completes and the step reads as HANDLED on the run report — when in truth nobody did it.
// That is the failure this fixes: as a `manual` step it becomes a checklist item an operator must
// actually tick off. (Same bug class as the framework-systems backfill next door.)
//
// THE SAFETY RULE: only rows with NO usable credential are flipped. If a client HAS wired a secret for
// one of these systems, that is a deliberate signal that they expect it to run — leave it `api` and
// surface it, rather than silently downgrading a system someone was in the middle of setting up.
// Lanes, deps, secretNames and config are untouched; nothing is created or deleted. Idempotent.
// Live Job rows on existing cases are deliberately NOT touched (the next planned case picks up the
// new mode).
import { db } from "../lib/db";
import { secretIsSet } from "../lib/secrets/wiring";

// No executor, no credential anywhere in the fleet, no modeled config. See the header.
const UNCREDENTIALED_KEYS = ["sharepoint", "mdm", "printix", "archive", "notion"] as const;
const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await db.clientSystem.findMany({
    where: { systemKey: { in: [...UNCREDENTIALED_KEYS] }, mode: "api" },
    select: {
      id: true, systemKey: true, clientId: true, secretNames: true,
      client: { select: { slug: true, name: true, secrets: { select: { name: true, externalId: true } } } },
    },
    orderBy: [{ systemKey: "asc" }, { clientId: "asc" }],
  });

  // A row is credentialed if it names a secret the client has actually wired. Those are left alone.
  const credentialed = rows.filter((r) =>
    (r.secretNames ?? []).some((n) => r.client.secrets.some((s) => s.name === n && secretIsSet(s.externalId)))
  );
  const flip = rows.filter((r) => !credentialed.includes(r));

  if (credentialed.length > 0) {
    console.log(`LEAVING ${credentialed.length} row(s) as api — they have a credential wired, so someone means to run them:`);
    for (const r of credentialed) console.log(`  ${r.client.slug}/${r.systemKey} (${r.secretNames.join(", ")})`);
    console.log("");
  }

  if (flip.length === 0) {
    console.log("nothing to do — no uncredentialed api rows for these systems");
    return;
  }

  const byKey = new Map<string, number>();
  for (const r of flip) byKey.set(r.systemKey, (byKey.get(r.systemKey) ?? 0) + 1);
  console.log(`${APPLY ? "FLIPPING" : "would flip"} ${flip.length} ClientSystem rows api -> manual (no credential, no modeled behaviour):`);
  for (const [key, n] of [...byKey].sort((a, b) => b[1] - a[1])) console.log(`  ${key.padEnd(12)} ${n} clients`);
  console.log(`\nexamples: ${flip.slice(0, 5).map((r) => `${r.client.slug}/${r.systemKey}`).join(", ")}${flip.length > 5 ? ", …" : ""}`);

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply to write.");
    return;
  }

  const result = await db.clientSystem.updateMany({ where: { id: { in: flip.map((r) => r.id) } }, data: { mode: "manual" } });

  // One audit row per client touched — a fleet-wide change has to be traceable per client, the same
  // way a hand edit on the client page would be.
  await db.auditLog.createMany({
    data: flip.map((r) => ({
      actor: "script:backfill-uncredentialed-system-modes",
      action: "client.system.mode.set",
      clientId: r.clientId,
      detail: { systemKey: r.systemKey, from: "api", to: "manual", reason: "no credential and no modeled behaviour — checklist step, was silently reporting 'skipped: no executor'" },
    })),
  });

  console.log(`\nflipped ${result.count} rows; wrote ${flip.length} audit entries.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
