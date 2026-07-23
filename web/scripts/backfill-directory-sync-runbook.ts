// Backfill: clients that already have a directory-sync ClientSystem row but NO matching
// directory-sync RunbookSection. Until the "Add directory-sync" button also wrote the runbook step,
// clicking it (or a hand-add) left the system present — so it ran and showed in readiness — but the
// runbook editor / documented step list never got a directory-sync section. This adds the missing
// section (onboard + offboard) using the same idempotent server path the button now uses.
//
//   npx tsx scripts/backfill-directory-sync-runbook.ts                 # dry run — prints the plan, writes nothing
//   npx tsx scripts/backfill-directory-sync-runbook.ts --apply         # inserts the missing sections
//   npx tsx scripts/backfill-directory-sync-runbook.ts --slug core536  # limit to one client (dry run)
//   npx tsx scripts/backfill-directory-sync-runbook.ts --slug core536 --apply
//
// SCOPE: only inserts runbook sections. It never creates/edits the ClientSystem row (it already
// exists for these clients) and never touches the backbone (setAdSynced=false). Existing runbook
// sections keep their content; only their seq shifts to make room. Idempotent — a second run finds
// nothing to do. Attribution: audited as actor "script:backfill-directory-sync-runbook".
import { db } from "../lib/db";
import { addDirectorySyncToClient } from "../lib/clients/add-directory-sync";
import { DIRECTORY_SYNC_KEY } from "../lib/clients/directory-sync-runbook";

const APPLY = process.argv.includes("--apply");
const slugArg = (() => {
  const i = process.argv.indexOf("--slug");
  return i !== -1 ? process.argv[i + 1] : null;
})();

async function main() {
  // Clients with a directory-sync ClientSystem row (optionally narrowed to one slug).
  const withSystem = await db.client.findMany({
    where: {
      ...(slugArg ? { slug: slugArg } : {}),
      systems: { some: { systemKey: DIRECTORY_SYNC_KEY } },
    },
    select: {
      slug: true,
      name: true,
      runbook: {
        where: { systemKey: DIRECTORY_SYNC_KEY },
        select: { action: true },
      },
    },
    orderBy: { slug: "asc" },
  });

  // Affected = missing the directory-sync section in onboard and/or offboard.
  const affected = withSystem
    .map((c) => {
      const have = new Set(c.runbook.map((r) => r.action));
      const missing = (["onboard", "offboard"] as const).filter((a) => !have.has(a));
      return { slug: c.slug, name: c.name, missing };
    })
    .filter((c) => c.missing.length > 0);

  if (slugArg && withSystem.length === 0) {
    console.log(`no client "${slugArg}" has a directory-sync system — nothing to do`);
    return;
  }
  if (affected.length === 0) {
    console.log("nothing to do — every directory-sync client already has its runbook section");
    return;
  }

  console.log(`${APPLY ? "BACKFILLING" : "would backfill"} ${affected.length} client(s):`);
  for (const c of affected) console.log(`  ${c.slug.padEnd(12)} ${c.name} — missing: ${c.missing.join(", ")}`);

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply to write.");
    return;
  }

  let added = 0;
  for (const c of affected) {
    // System already exists so orderAfter is inert here; setAdSynced=false leaves the backbone alone.
    const res = await addDirectorySyncToClient(
      db,
      c.slug,
      { orderAfter: "active-directory", setAdSynced: false },
      "script:backfill-directory-sync-runbook"
    );
    const secs = res?.sectionsAdded ?? [];
    console.log(`  ${c.slug.padEnd(12)} added: ${secs.length ? secs.join(", ") : "none"}`);
    added += secs.length;
  }
  console.log(`\ndone — inserted ${added} runbook section(s) across ${affected.length} client(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
