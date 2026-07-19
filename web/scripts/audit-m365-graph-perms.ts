/* What Graph permissions does every client's M365/Entra app registration have — and what is missing?
 *
 *   npx tsx scripts/audit-m365-graph-perms.ts                 # every client
 *   npx tsx scripts/audit-m365-graph-perms.ts --client core2030
 *   npx tsx scripts/audit-m365-graph-perms.ts --missing UserAuthenticationMethod.ReadWrite.All
 *   npx tsx scripts/audit-m365-graph-perms.ts --json > perms.json
 *
 * The same sweep the /audits page runs — both call lib/audits/m365-audit.ts, so the CLI and the UI can
 * never disagree. This is the scriptable path: pipe it, diff it, run it from CI.
 *
 * Read-only. Prints verdicts and permission NAMES only — never a credential value.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { scanPermissions, pivotByPermission } from "../lib/audits/m365-audit";
import { GRAPH_APP_ROLE_IDS, GRAPH_RESOURCE_APP_ID } from "../lib/secrets/graph-caps";

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
const onlyMissing = flag("--missing");
const asJson = argv.includes("--json");

const db = new PrismaClient();

(async () => {
  if (!asJson) console.error(onlyClient ? `checking ${onlyClient}…\n` : "checking every wired m365-admin credential…\n");
  const rows = await scanPermissions(db, { onlyClient });
  await db.$disconnect();

  const shown = onlyMissing
    ? rows.filter((r) => [...r.missingRequired, ...r.missingOptional].some((m) => m.toLowerCase() === onlyMissing.toLowerCase()))
    : rows;

  if (asJson) { console.log(JSON.stringify(shown, null, 2)); return; }

  const mark = { ok: "✓", gaps: "✗", unverified: "?", "cred-bad": "!", "no-cred": "-" } as const;
  for (const r of shown) {
    const bits: string[] = [];
    if (r.missingRequired.length) bits.push(`MISSING: ${r.missingRequired.join(", ")}`);
    if (r.missingOptional.length) bits.push(`optional: ${r.missingOptional.join(", ")}`);
    // Over-permissioned is the other half of the question, and the half a client's security team
    // cares about. Escalation-capable roles get shouted; the rest are a quiet note.
    const esc = r.surplus.filter((s) => s.escalation);
    if (esc.length) bits.push(`OVER-PERMISSIONED: ${esc.map((s) => s.role).join(", ")}`);
    const spare = r.surplus.filter((s) => !s.escalation);
    if (spare.length) bits.push(`unused: ${spare.map((s) => s.role).join(", ")}`);
    if (r.detail) bits.push(r.detail);
    console.log(`${mark[r.status]} ${r.client.padEnd(38).slice(0, 38)} ${r.slug.padEnd(10)} ${bits.join(" · ") || `${r.granted.length} role(s), all capabilities covered`}`);
  }

  console.log(`\n${"—".repeat(78)}`);
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  console.log(`${n("ok")}/${rows.length} fully covered · ${n("gaps")} with gaps · ${n("unverified")} unverified · ${n("cred-bad") + n("no-cred")} with no usable credential`);

  // Grouped by permission: one fix covers every client that needs it. Unverified rows are excluded by
  // pivotByPermission — an unconfirmed gap must never reach a to-do list.
  const pivot = pivotByPermission(rows);
  if (pivot.length) {
    console.log(`\nTo grant a missing permission (Entra admin center, per tenant):`);
    console.log(`  App registrations → <the app> → API permissions → Add a permission →`);
    console.log(`  Microsoft Graph → Application permissions → tick the role → Add → "Grant admin consent"`);
    console.log(`\nOr non-interactively, as an admin in that tenant (Graph resource app id ${GRAPH_RESOURCE_APP_ID}):`);
    for (const p of pivot) {
      const id = GRAPH_APP_ROLE_IDS[p.role];
      console.log(`\n  ${p.role}${p.optional ? " (optional)" : ""} — ${p.clients.length} client(s):`);
      for (const c of p.clients) console.log(`    - ${c.client || c.slug}`);
      if (id) {
        console.log(`    $sp    = Get-MgServicePrincipal -Filter "appId eq '<the app id>'"`);
        console.log(`    $graph = Get-MgServicePrincipal -Filter "appId eq '${GRAPH_RESOURCE_APP_ID}'"`);
        console.log(`    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id \`\n      -PrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId ${id}`);
      }
    }
  }
  // The reverse pivot: who holds authority the engine never needs. Escalation roles are listed with
  // WHAT they permit rather than just named — "RoleManagement.ReadWrite.Directory" means nothing to
  // most readers; "can make itself Global Administrator" ends the conversation.
  const byEscalation = new Map<string, { why: string; clients: { slug: string; client: string }[] }>();
  for (const r of rows) {
    for (const s of r.surplus.filter((x) => x.escalation)) {
      const e = byEscalation.get(s.role) ?? { why: s.why, clients: [] };
      e.clients.push({ slug: r.slug, client: r.client });
      byEscalation.set(s.role, e);
    }
  }
  if (byEscalation.size) {
    console.log(`\n${"—".repeat(78)}`);
    console.log(`OVER-PERMISSIONED — these credentials hold authority this engine never uses.`);
    console.log(`Each is a standing escalation primitive on a secret a runner reads at execution time.`);
    for (const [role, e] of [...byEscalation].sort((a, b) => b[1].clients.length - a[1].clients.length)) {
      console.log(`\n  ${role} — ${e.clients.length} client(s):`);
      for (const c of e.clients) console.log(`    - ${c.client || c.slug}`);
      console.log(`    ${e.why}`);
    }
    console.log(`\n  Removing one is a client-side decision — the app registration may be shared with`);
    console.log(`  tooling that is none of ours. Report it; don't assume it is ours to revoke.`);
  }

  const unverified = rows.filter((r) => r.status === "unverified");
  if (unverified.length) {
    console.log(`\n${unverified.length} client(s) could not be fully read (Graph throttling) — re-run for those:`);
    for (const r of unverified) console.log(`  - ${r.client || r.slug}`);
  }
})().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
