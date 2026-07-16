/* Who is disabled but still holding an M365 licence — and was their mailbox ever converted to shared?
 *
 *   npx tsx scripts/audit-leaked-seats.ts --client core2030
 *   npx tsx scripts/audit-leaked-seats.ts
 *   npx tsx scripts/audit-leaked-seats.ts --json > leaks.json
 *
 * The same sweep the /audits page runs — both call lib/audits/m365-audit.ts, so the CLI and the UI can
 * never disagree. This is the scriptable path.
 *
 * A disabled user with a licence is a leaver we are still paying for. Until 2026-07-16 that was every
 * offboard for a client that converts mailboxes to shared: the step order was an ONBOARD order, so the
 * licence step ran BEFORE the mailbox convert, correctly refused to strip a licence off an unconverted
 * mailbox, and nothing ever re-ran it (UM0029796). The planner is fixed, but only for FUTURE offboards
 * — every seat already leaked is still assigned. This finds them.
 *
 * Read-only. The mailbox state decides what you may safely do:
 *   shared      -> safe to remove the licence now
 *   not shared  -> convert FIRST; removing it lets Exchange purge the mailbox after its 30-day grace
 *   unknown     -> usually a missing MailboxSettings.Read; find out before acting
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { scanLeakedSeats, leakVerdict } from "../lib/audits/m365-audit";

function loadEnvFiles(): void {
  for (const p of [resolve(__dirname, "..", ".env"), resolve(__dirname, "..", "..", ".env")]) {
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2];
      const dq = v.match(/^"([^"]*)"/);
      if (dq) v = dq[1]; else v = v.replace(/\s+#.*$/, "");
      process.env[m[1]] = v.trim();
    }
  }
}
loadEnvFiles();

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const onlyClient = flag("--client");
const asJson = argv.includes("--json");

const db = new PrismaClient();

(async () => {
  if (!asJson) console.error(onlyClient ? `scanning ${onlyClient}…\n` : "scanning every wired m365-admin credential…\n");
  const leaks = await scanLeakedSeats(db, { onlyClient });
  await db.$disconnect();

  if (asJson) { console.log(JSON.stringify(leaks.map((l) => ({ ...l, action: leakVerdict(l.mailbox) })), null, 2)); return; }

  if (!leaks.length) console.log("no disabled-but-licensed users found — nothing leaking");
  let lastClient = "";
  for (const l of leaks) {
    if (l.client !== lastClient) { console.log(`\n${l.client} (${l.slug})`); lastClient = l.client; }
    const m = l.mailbox === "shared" ? "shared" : l.mailbox === "not-shared" ? "NOT shared" : "mailbox ?";
    console.log(`  ${l.userPrincipalName.padEnd(42).slice(0, 42)} ${l.licenses.join(", ").padEnd(24).slice(0, 24)} ${m.padEnd(10)} ${leakVerdict(l.mailbox)}`);
  }

  console.log(`\n${"—".repeat(78)}`);
  const c = (m: string) => leaks.filter((l) => l.mailbox === m).length;
  console.log(`${leaks.length} disabled user(s) still holding a licence across ${new Set(leaks.map((l) => l.slug)).size} client(s)`);
  console.log(`  ${c("shared")} safe to reclaim now · ${c("not-shared")} need the mailbox converted first · ${c("unknown")} unknown mailbox state`);
  if (c("unknown")) console.log(`\nAn unknown mailbox state usually means that tenant has not granted MailboxSettings.Read.\nRun: npx tsx scripts/audit-m365-graph-perms.ts --missing MailboxSettings.Read`);
})().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
