// Backfill for FR #0000082: "Back Office Users" is added to every Six One onboard.
//
// It was never hardcoded in PowerShell (the request says it was) — it sat in the AD onboard lane's
// unconditional `groups` list, which the AD module simply applies. profiles/six-one.json is fixed,
// but profiles are only the SEED source: the live config is the ClientSystem row, so the profile
// edit alone changes nothing for the next onboard. This removes it from that row.
//
// After this runs, the group is added only when someone picks it on the ticket — requested security
// groups already route to the directory that MASTERS them (FR #0000004), which is AD for Six One.
//
//   npx tsx scripts/backfill-six-one-back-office.ts                 # dry run — prints, writes nothing
//   npx tsx scripts/backfill-six-one-back-office.ts --apply         # removes the group
//   npx tsx scripts/backfill-six-one-back-office.ts --slug six-one --apply
//
// SCOPE: only the named group, only from `groups` on the active-directory ONBOARD config, only for
// clients whose config actually lists it. conditionalGroups are untouched (61C-CORE_Users and the
// Perimeter 81 bundle stay exactly as they are — they are already request-gated by their `when`).
// Idempotent: a second run finds nothing to do.
import { db } from "../lib/db";

const GROUP = "Back Office Users";
const DEFAULT_SLUG = "six-one";
const APPLY = process.argv.includes("--apply");
const slugArg = (() => {
  const i = process.argv.indexOf("--slug");
  return i !== -1 ? process.argv[i + 1] : null;
})();
const slug = slugArg ?? DEFAULT_SLUG;

// Case-insensitive so a hand-typed "back office users" is caught too.
function withoutGroup(groups: unknown): { next: string[]; removed: string[] } | null {
  if (!Array.isArray(groups)) return null;
  const removed: string[] = [];
  const next: string[] = [];
  for (const g of groups) {
    // A conditional bundle ({ groups, when }) is NOT a plain name — leave it alone.
    if (typeof g !== "string") { next.push(g as unknown as string); continue; }
    if (g.trim().toLowerCase() === GROUP.toLowerCase()) removed.push(g);
    else next.push(g);
  }
  return removed.length ? { next, removed } : null;
}

async function main() {
  const client = await db.client.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, systems: { where: { systemKey: "active-directory" }, select: { id: true, config: true } } },
  });
  if (!client) {
    console.error(`no client with slug "${slug}"`);
    process.exitCode = 1;
    return;
  }
  if (client.systems.length === 0) {
    console.log(`${client.name} (${client.slug}): no active-directory system row — nothing to do`);
    return;
  }

  // ClientSystem.config is a single Json shaped { onboard, offboard } (prisma/seed.ts:121-123) —
  // the per-lane config lives INSIDE it. Only the onboard lane is touched here.
  let changed = 0;
  for (const sys of client.systems) {
    const config = (sys.config ?? {}) as Record<string, unknown>;
    const onboard = (config.onboard ?? {}) as Record<string, unknown>;
    const hit = withoutGroup(onboard.groups);
    if (!hit) {
      console.log(`${client.slug}: active-directory onboard groups do not list "${GROUP}" — nothing to do`);
      continue;
    }
    console.log(`${client.slug}: removing ${hit.removed.map((r) => `"${r}"`).join(", ")} from active-directory onboard groups`);
    console.log(`  before: ${JSON.stringify(onboard.groups)}`);
    console.log(`  after:  ${JSON.stringify(hit.next)}`);
    if (APPLY) {
      await db.clientSystem.update({
        where: { id: sys.id },
        data: { config: { ...config, onboard: { ...onboard, groups: hit.next } } },
      });
      changed++;
    }
  }

  console.log(APPLY ? `applied — ${changed} system row(s) updated` : "dry run — nothing written (re-run with --apply)");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
