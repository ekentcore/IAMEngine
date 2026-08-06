// Post a shipped change-log entry to the configured chat channels, from the command line.
//
// This is the unattended half of the "Send to chat" button. prs.sh calls it after a successful merge
// so what just shipped reaches the room without anyone remembering to click. It reads BOTH the
// Postgres credentials and the chat destinations the same way the app does:
//
//   credentials — POSTGRES_* out of the repo-root env file (env.env, or .env), assembled into a
//                 DATABASE_URL by the same buildDatabaseUrl() that generates web/.env. Nothing is
//                 duplicated by hand and no connection string is passed on the command line (it
//                 carries a password, and argv is world-readable in `ps`).
//   destinations — AppSetting["failure_notifications"], the row the Settings > Notifications page
//                 writes. Same channels, same default/restricted split, same enabled flags as every
//                 other alert. Turning a channel off in the UI turns it off here, with no redeploy.
//
// The message is composed by lib/changelog/announce.ts and sent by lib/notifications/sender.ts — the
// same two modules the button uses, so a send from here is byte-identical to a send from the UI.
//
//   npx tsx scripts/announce-merged.ts --entry <changelog-id>
//   npx tsx scripts/announce-merged.ts --pr 42                  # resolve entry ids from the PR's diff
//   npx tsx scripts/announce-merged.ts --pr 42 --dry-run        # print what would go, send nothing
//   npx tsx scripts/announce-merged.ts --entry foo --audience both --comment "..."
//
// --audience default/restricted/both mirrors the button. Default is "all" (the non-restricted rooms):
// a build announcement is not client-confidential, and defaulting to "both" would push every merge
// into the restricted room too.
//
// SAFETY. This posts to REAL customer chat channels. Three guards, all deliberate:
//   - --dry-run resolves everything (env, DB, settings, destinations, message) and sends nothing. It
//     is the only mode that is safe to run casually, and the one prs.sh uses when unconfirmed.
//   - An unknown entry id is a hard error, never a silent no-op. A typo'd id used to be indisti-
//     nguishable from a successful send.
//   - The master switch is BYPASSED, exactly as the button does (an explicit operator action, like a
//     test send) — but only SAVED destinations are used. It cannot invent a webhook.
// It deliberately does NOT touch the feature-request table: flipping a request to Implemented is a
// judgement about whether the request was satisfied, not a fact about a merge.
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseEnvFile, buildDatabaseUrl } from "./read-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DRY = has("dry-run");
const AUDIENCES = ["all", "restricted", "both"] as const;
type Audience = (typeof AUDIENCES)[number];
const audienceArg = arg("audience");
if (audienceArg && !AUDIENCES.includes(audienceArg as Audience)) {
  console.error(`--audience must be one of: ${AUDIENCES.join(", ")}`);
  process.exit(1);
}
const AUDIENCE: Audience = (audienceArg as Audience) ?? "all";
const COMMENT = arg("comment") ?? "automatic update by Claude AI";

// The repo-root env file. read-env.mjs names env.env; this repo actually ships .env, and a checkout
// may have either — so try both rather than failing on a filename.
function envPath(): string {
  for (const name of ["env.env", ".env"]) {
    const p = resolve(ROOT, name);
    if (existsSync(p)) return p;
  }
  console.error(`no env file at ${ROOT} (looked for env.env and .env) — cannot resolve POSTGRES_* credentials`);
  process.exit(1);
}

// Which change-log entries did this PR add? The registry line is the reliable signal: an entry is only
// in the log once it is exported from _registry.ts, so a PR that adds a file without registering it
// has not really shipped an entry (registry.test.ts fails on exactly that).
function entryIdsFromPr(pr: string): string[] {
  let out = "";
  try {
    out = execFileSync("gh", ["pr", "diff", pr, "--name-only"], { encoding: "utf8", cwd: ROOT });
  } catch {
    console.error(`could not read PR #${pr} with gh — pass --entry <id> instead`);
    process.exit(1);
  }
  const ids: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^web\/lib\/changelog\/entries\/([a-z0-9-]+)\.ts$/.exec(line.trim());
    if (m && m[1] !== "_registry" && !m[1].endsWith(".test")) ids.push(m[1]);
  }
  return ids;
}

async function main() {
  // Assemble DATABASE_URL BEFORE importing anything that touches Prisma — lib/db instantiates the
  // client at import time and reads the variable then. A dynamic import below is what makes the
  // ordering guaranteed rather than incidental.
  // read-env.mjs is untyped JS, so name the shape we rely on rather than indexing `{}`.
  const env = parseEnvFile(envPath()) as Record<string, string | undefined>;
  const { url, dbName } = buildDatabaseUrl(env);
  if (!env.POSTGRES_HOST || !env.POSTGRES_USER) {
    console.error("the env file has no POSTGRES_HOST/POSTGRES_USER — cannot reach the database");
    process.exit(1);
  }
  process.env.DATABASE_URL = url;

  const entryIds = (() => {
    const one = arg("entry");
    if (one) return [one];
    const pr = arg("pr");
    if (pr) return entryIdsFromPr(pr);
    console.error("pass --entry <changelog-id> or --pr <number>");
    process.exit(1);
  })();

  if (entryIds.length === 0) {
    console.log("no change-log entry in that PR — nothing to announce.");
    return;
  }

  const { CHANGELOG } = await import("../lib/changelog/entries");
  const { changelogAnnouncement } = await import("../lib/changelog/announce");
  const { db } = await import("../lib/db");
  const { getAppSetting } = await import("../lib/settings");
  const { NOTIFICATIONS_SETTING_KEY, normalizeSettings } = await import("../lib/notifications/types");
  const { sendAnnouncement } = await import("../lib/notifications/sender");

  // Resolve every id up front: a typo must fail before ANY message goes out, or a two-entry send
  // posts the first and then dies, and re-running double-posts it.
  const entries = entryIds.map((id) => {
    const e = CHANGELOG.find((x) => x.id === id);
    if (!e) {
      console.error(`unknown change-log entry "${id}" — it is not exported from lib/changelog/entries/_registry.ts`);
      process.exit(1);
    }
    return e;
  });

  console.log(`db: ${env.POSTGRES_HOST}/${dbName}`);
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));

  // Say WHERE it is going before it goes. A send whose destinations you can't see is a send you
  // can't sanity-check, and these are customer rooms.
  const variant = AUDIENCE === "restricted" ? (["restricted"] as const) : AUDIENCE === "both" ? (["default", "restricted"] as const) : (["default"] as const);
  const live: string[] = [];
  for (const [name, pair] of Object.entries(settings.channels)) {
    for (const v of variant) {
      const d = (pair as Record<string, { enabled?: boolean; webhookUrl?: string; recipients?: string[] }>)[v];
      if (!d?.enabled) continue;
      if (name === "email") { if (d.recipients?.length) live.push(`${name}/${v} -> ${d.recipients.length} recipient(s)`); }
      else if (d.webhookUrl) live.push(`${name}/${v}`);
    }
  }
  if (live.length === 0) {
    console.log(`no enabled ${AUDIENCE} destination in Settings > Notifications — nothing to send to.`);
    await db.$disconnect();
    return;
  }
  console.log(`destinations (${AUDIENCE}): ${live.join(", ")}`);

  for (const entry of entries) {
    const { title, detail } = changelogAnnouncement(entry, COMMENT);
    if (DRY) {
      console.log(`\n--- dry run, NOT sent ---\n${title}\n${detail}\n-------------------------`);
      continue;
    }
    const results = await sendAnnouncement(settings, AUDIENCE, { event: "announcement", title, detail });
    const failed = results.filter((r) => !r.ok);
    for (const r of results) console.log(`  ${r.ok ? "sent" : "FAILED"}  ${r.channel}${r.error ? ` — ${r.error}` : ""}`);
    if (failed.length === results.length && results.length > 0) process.exitCode = 1; // every channel failed
    console.log(`${DRY ? "would announce" : "announced"}: ${entry.id}`);
  }

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
