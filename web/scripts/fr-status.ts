// Set a feature request's status and resolution note from the command line.
//
// The web UI is the normal way to triage a request. This exists for the case where whoever shipped
// the fix cannot reach the app — a dev box that isn't allowlisted on the database firewall, a CI step,
// or an operator working from a machine with psql access but no session. It is the same mutation the
// triage panel performs, not a shortcut around it:
//
//   - the status must be one of FR_STATUSES; anything else is refused, so a typo can't invent a state
//     that the board's open/resolved split doesn't understand
//   - the 7-day archive timer is armed by the SAME frHideAtOnStatusChange the route uses, so a request
//     resolved here lands in the collapsed Completed table on the same schedule as one resolved in the
//     UI (getting this wrong would leave it on the board forever, or bury it immediately)
//   - the change is written to AuditLog, attributed to `script:fr-status` — a status flip nobody can
//     account for is worse than no flip
//
// Credentials come from the repo-root env file (POSTGRES_*), assembled by the same buildDatabaseUrl()
// that writes web/.env — never a connection string on the command line, which would put the password
// into `ps`.
//
//   npx tsx scripts/fr-status.ts 82 done --note "what shipped, in a sentence"
//   npx tsx scripts/fr-status.ts 46 building
//   npx tsx scripts/fr-status.ts 82 done --note "..." --dry-run
//
// The request is addressed by its NUMBER (the #0000082 operators quote), not its cuid — the number is
// what appears on the board and in chat, and is the only id a human has to hand.
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnvFile, buildDatabaseUrl } from "./read-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const numberArg = positional[0];
const statusArg = positional[1];
const DRY = process.argv.includes("--dry-run");
const noteArg = (() => {
  const i = process.argv.indexOf("--note");
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
})();

function envPath(): string {
  for (const name of ["env.env", ".env"]) {
    const p = resolve(ROOT, name);
    if (existsSync(p)) return p;
  }
  console.error(`no env file at ${ROOT} (looked for env.env and .env) — cannot resolve POSTGRES_* credentials`);
  process.exit(1);
}

async function main() {
  const { FR_STATUSES } = await import("../lib/feature-requests/status");

  if (!numberArg || !statusArg) {
    console.error(`usage: npx tsx scripts/fr-status.ts <number> <${FR_STATUSES.join("|")}> [--note "..."] [--dry-run]`);
    process.exit(1);
  }
  const number = Number(numberArg);
  if (!Number.isInteger(number) || number <= 0) {
    console.error(`expected a feature-request NUMBER (e.g. 82), got: ${numberArg}`);
    process.exit(1);
  }
  if (!(FR_STATUSES as readonly string[]).includes(statusArg)) {
    console.error(`status must be one of: ${FR_STATUSES.join(", ")}`);
    process.exit(1);
  }
  // Mirrors the route's cap. Refuse rather than silently truncate — a half-written resolution note is
  // a misleading permanent record.
  if (noteArg !== null && noteArg.trim().length > 5000) {
    console.error("--note must be at most 5000 characters");
    process.exit(1);
  }

  const env = parseEnvFile(envPath()) as Record<string, string | undefined>;
  if (!env.POSTGRES_HOST || !env.POSTGRES_USER) {
    console.error("the env file has no POSTGRES_HOST/POSTGRES_USER — cannot reach the database");
    process.exit(1);
  }
  const { url, dbName } = buildDatabaseUrl(env);
  process.env.DATABASE_URL = url; // set BEFORE lib/db is imported — it reads this at import time

  const { db } = await import("../lib/db");
  const { frHideAtOnStatusChange } = await import("../lib/feature-requests/visibility");
  const { recordAudit } = await import("../lib/auth/audit");
  const { frNumber } = await import("../lib/feature-requests/visibility");

  console.log(`db: ${env.POSTGRES_HOST}/${dbName}`);
  const existing = await db.featureRequest.findUnique({ where: { number } });
  if (!existing) {
    console.error(`no feature request numbered ${number}`);
    await db.$disconnect();
    process.exit(1);
  }

  const data: { status: string; resolutionNote?: string | null; hideAt?: Date | null } = { status: statusArg };
  if (noteArg !== null) {
    const note = noteArg.trim();
    data.resolutionNote = note === "" ? null : note;
  }
  // Same timer rule as the route — undefined means "leave any manual archive alone".
  const hideAt = frHideAtOnStatusChange(existing.status, statusArg, new Date(), existing.hideAt);
  if (hideAt !== undefined) data.hideAt = hideAt;

  console.log(`${frNumber(existing.number)}  ${existing.title}`);
  console.log(`  status: ${existing.status} -> ${statusArg}`);
  if (data.resolutionNote !== undefined) console.log(`  note:   ${data.resolutionNote ?? "(cleared)"}`);
  if (data.hideAt !== undefined) console.log(`  hideAt: ${data.hideAt?.toISOString() ?? "(cleared — back on the board)"}`);

  if (DRY) {
    console.log("dry run — nothing written.");
    await db.$disconnect();
    return;
  }

  const updated = await db.featureRequest.update({ where: { id: existing.id }, data });
  await recordAudit("feature_request.update", {
    actor: "script:fr-status",
    detail: {
      id: updated.id, number: updated.number, title: updated.title,
      from: existing.status, to: updated.status,
      notedResolution: data.resolutionNote !== undefined,
      hideAt: updated.hideAt?.toISOString() ?? null,
    },
  });
  console.log("updated.");
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
