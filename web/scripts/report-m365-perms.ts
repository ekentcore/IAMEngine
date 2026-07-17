/* The M365 Graph permission state of every client that has Microsoft 365 — printed, or sent to chat.
 *
 *   npx tsx scripts/report-m365-perms.ts                      # print it (default — never sends)
 *   npx tsx scripts/report-m365-perms.ts --send               # print it, then post to the chat rooms
 *   npx tsx scripts/report-m365-perms.ts --audience both      # all (default) | restricted | both
 *   npx tsx scripts/report-m365-perms.ts --role Mail.Send     # headline a different permission
 *   npx tsx scripts/report-m365-perms.ts --from perms.json    # reuse a captured sweep, skip Graph
 *   npx tsx scripts/report-m365-perms.ts --json               # the joined rows, for piping
 *
 * Unlike audit-m365-graph-perms.ts, this covers clients with NO credential wired: that script walks
 * the wired m365-admin secrets (the right set for "who is missing a role"), which silently omits the
 * ~63 clients whose M365 is not configured at all. See lib/audits/m365-fleet-report.ts.
 *
 * `--from` exists because the sweep costs one Graph round trip per client and the send is the part
 * you iterate on. Capture once with `audit-m365-graph-perms.ts --json`, then format freely.
 *
 * Read-only against Graph and the DB. Prints verdicts and permission NAMES only — never a credential
 * value, and never a webhook URL or token.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { scanPermissions, type PermissionRow } from "../lib/audits/m365-audit";
import { buildFleetRows, reportLines, summarize, chunkLines, reportableRoles, type M365Client } from "../lib/audits/m365-fleet-report";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings } from "../lib/notifications/types";
import { sendAnnouncement, type AnnouncementAudience } from "../lib/notifications/sender";
import { getAppSetting } from "../lib/settings";

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
const send = argv.includes("--send");
const asJson = argv.includes("--json");
const from = flag("--from");
const role = flag("--role") ?? "User-PasswordProfile.ReadWrite.All";
const audience = (flag("--audience") ?? "all") as AnnouncementAudience;

const db = new PrismaClient();

// The "not set" sentinels the secret sweeps skip — an empty slot is not a wired credential.
const UNSET = ["", "REPLACE_ME", "NOT_NEEDED"];

// Every live client that has Microsoft 365 at all, and whether an m365-admin credential is wired for
// it. Both facts come from the database: "not configured" is a fact about the Secret rows, never an
// inference from the client's absence from whatever sweep we happen to be holding.
async function m365Clients(): Promise<M365Client[]> {
  const rows = await db.client.findMany({
    where: { archivedAt: null, systems: { some: { systemKey: { in: ["m365", "entra"] } } } },
    select: { slug: true, name: true, secrets: { where: { name: "m365-admin" }, select: { externalId: true } } },
    orderBy: { name: "asc" },
  });
  // The same wired-or-not test auditTargets uses, so this can't disagree with what the sweep walked.
  return rows.map((r) => ({ slug: r.slug, name: r.name, hasCredential: r.secrets.some((s) => !UNSET.includes(s.externalId.trim())) }));
}

// A failed send's error can quote the destination — Node's own "Failed to parse URL from <url>" does
// exactly that for a malformed webhook — and this script both prints the error and persists it to
// AuditLog. Neither may carry a webhook URL or a Zoom token, so scrub anything URL-shaped out of a
// transport error before it goes anywhere. Over-broad on purpose: an over-redacted error is a support
// question, a leaked webhook is a chat room anyone can post to.
const scrubUrls = (s: string | undefined): string | undefined =>
  s?.replace(/\b(?:https?:\/\/|hooks\.)\S+/gi, "<redacted url>");

(async () => {
  if (!["all", "restricted", "both"].includes(audience)) throw new Error(`--audience must be all, restricted or both (got ${audience})`);
  // --role names the permission the headline counts. Only a capability's suggested role can ever
  // appear in a missing list, so anything else would silently headline a truthful-looking "0/31".
  if (!reportableRoles().some((r) => r.toLowerCase() === role.toLowerCase())) {
    throw new Error(`--role ${role} is never reported as missing, so it would headline a false 0.\nReportable roles:\n  ${reportableRoles().join("\n  ")}`);
  }

  const clients = await m365Clients();
  let perm: PermissionRow[];
  if (from) {
    perm = JSON.parse(readFileSync(from, "utf8")) as PermissionRow[];
    if (!asJson) console.error(`using the captured sweep in ${from} (${perm.length} rows)\n`);
  } else {
    if (!asJson) console.error(`checking every wired m365-admin credential (${clients.length} clients have M365)…\n`);
    perm = await scanPermissions(db);
  }

  const rows = buildFleetRows(perm, clients);
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); await db.$disconnect(); return; }

  const lines = reportLines(rows, role);
  const s = summarize(rows, role);
  const stamp = new Date().toISOString().slice(0, 10);
  const chunks = chunkLines(lines, (i, n) => (n === 1 ? `Microsoft 365 permissions — fleet report (${stamp})` : `Microsoft 365 permissions — fleet report (${stamp}) ${i + 1}/${n}`));

  for (const c of chunks) {
    console.log(`\n${"═".repeat(78)}\n${c.title}\n${"═".repeat(78)}`);
    console.log(c.detail);
  }
  console.error(`\n${chunks.length} chat message(s); ${s.total} clients.`);

  if (!send) {
    console.error(`\nNothing sent. Re-run with --send to post to the "${audience}" chat destination(s).`);
    await db.$disconnect();
    return;
  }

  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  console.error(`\nsending ${chunks.length} message(s) to the "${audience}" destination(s)…`);
  // SEQUENTIALLY, and never in parallel: these are numbered parts of one report, and a chat room
  // shows them in arrival order. Racing them scrambles the report. The small gap also keeps a
  // multi-part send under the incoming-webhook rate limit.
  const sent: { part: number; results: { channel: string; ok: boolean; error?: string }[] }[] = [];
  for (const [i, c] of chunks.entries()) {
    const raw = await sendAnnouncement(settings, audience, { event: "announcement", title: c.title, detail: c.detail });
    const results = raw.map((r) => ({ channel: r.channel as string, ok: r.ok, error: scrubUrls(r.error) }));
    sent.push({ part: i + 1, results });
    const bad = results.filter((r) => !r.ok);
    console.error(`  ${i + 1}/${chunks.length} → ${results.length ? results.map((r) => `${r.channel}:${r.ok ? "ok" : `FAILED ${r.error}`}`).join(" ") : "NO DESTINATION CONFIGURED"}`);
    if (bad.length) console.error(`     ↑ part ${i + 1} did not arrive — the report in chat is now incomplete`);
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 700));
  }

  const delivered = sent.flatMap((p) => p.results).filter((r) => r.ok).length;
  const attempted = sent.flatMap((p) => p.results).length;

  // Posting to a customer-visible room is exactly the kind of act the audit trail exists for, and the
  // UI's own send (app/api/admin/changelog) records one. A CLI is not a reason to skip it. Never the
  // message bodies: client names and permission names belong in chat, not in a second copy here. And
  // never an unscrubbed transport error — see scrubUrls.
  //
  // The action reflects what HAPPENED. "notification.sent" on a run where every channel was
  // unconfigured would put a delivery in the audit trail that never occurred — a log that lies is
  // worse than no log, and this one is the record of what the room was told.
  await db.auditLog.create({
    data: {
      actor: "script:report-m365-perms",
      action: delivered > 0 ? "notification.sent" : "notification.error",
      detail: { event: "announcement", report: "m365-graph-permissions", audience, role, parts: chunks.length, clients: s.total, delivered, attempted, results: sent },
    },
  }).catch((e: unknown) => console.error(`(recording the audit row failed: ${e instanceof Error ? e.message : String(e)})`));
  await db.$disconnect();

  // Exit non-zero when nothing reached anyone: --send that silently no-ops is how a report is believed
  // to have been filed when the room never saw it.
  if (attempted === 0) {
    console.error(`\nNOTHING WAS SENT: no "${audience}" destination is configured or enabled (Settings → notifications).`);
    process.exit(1);
  }
  if (delivered < attempted) {
    console.error(`\n${attempted - delivered} of ${attempted} sends FAILED — what is in chat is an incomplete report.`);
    process.exit(1);
  }
})().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
