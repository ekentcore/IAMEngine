/* Classify every wired m365-admin secret as an APP REGISTRATION vs a HUMAN USER ACCOUNT.
 *
 * Connect-CtgM365 connects with -ClientSecretCredential (the client-credentials flow): UserName must
 * be an APP ID (a GUID) and Password the app's client secret. A Global Admin's username/password —
 * however correct — can never authenticate that way. Both shapes carry a "Username" and a "Password",
 * so a field-NAME check cannot tell them apart; only the VALUE's shape can.
 *
 *   npx tsx scripts/audit-m365-cred-kind.ts          # report only
 *   npx tsx scripts/audit-m365-cred-kind.ts --fix    # un-wire the user-account ones (back to REPLACE_ME)
 *
 * --fix exists because a credential that RESOLVES but cannot authenticate is worse than an empty
 * slot: the app shows it wired, and it fails at dispatch time. Un-wiring restores an honest "not set"
 * and puts the client back on the "needs an app registration" list.
 *
 * Prints kinds only — never a credential value.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, resolveSecretFields } from "../lib/secrets/delinea";
import { classifyM365Credential } from "../lib/secrets/m365-credential";

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

const db = new PrismaClient();

(async () => {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) { console.error("✗ Delinea not configured"); process.exit(1); }
  const token = await getDelineaToken(cfg);

  const secrets = await db.secret.findMany({
    where: { name: "m365-admin", externalId: { notIn: ["", "REPLACE_ME", "NOT_NEEDED"] }, client: { archivedAt: null } },
    select: { externalId: true, client: { select: { name: true, slug: true, coreId: true } } },
    orderBy: { client: { name: "asc" } },
  });

  const FIX = process.argv.includes("--fix");
  const buckets = new Map<string, string[]>();
  const unusable: { slug: string; externalId: string }[] = [];

  for (const s of secrets) {
    const r = await resolveSecretFields(cfg, s.externalId, undefined, token);
    const kind = r.ok && r.fields ? classifyM365Credential(r.fields) : { kind: "unreadable" as const, reason: r.error ?? "resolve failed" };
    const line = `${s.client.name} (${s.client.coreId ?? s.client.slug}) · secret ${s.externalId} "${r.label ?? "?"}" — ${kind.reason}`;
    if (!buckets.has(kind.kind)) buckets.set(kind.kind, []);
    buckets.get(kind.kind)!.push(line);
    // "incomplete" is left alone: it may still be the right secret with a field to fill in. Only a
    // credential of the WRONG KIND is definitively unusable.
    if (kind.kind === "user-account") unusable.push({ slug: s.client.slug, externalId: s.externalId });
  }

  for (const [kind, lines] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n=== ${kind.toUpperCase()} (${lines.length}) ===`);
    for (const l of lines) console.log(`  ${l}`);
  }
  console.log(`\nTotal wired m365-admin: ${secrets.length}`);

  if (FIX && unusable.length) {
    let cleared = 0;
    for (const u of unusable) {
      // Guarded by externalId: only clear the exact reference we just judged, so a concurrent operator
      // fix isn't reverted.
      const res = await db.secret.updateMany({
        where: { name: "m365-admin", externalId: u.externalId, client: { slug: u.slug } },
        data: { externalId: "REPLACE_ME" },
      });
      cleared += res.count;
    }
    console.log(`\n✓ un-wired ${cleared} unusable m365-admin reference(s) → REPLACE_ME (they cannot authenticate).`);
  } else if (unusable.length) {
    console.log(`\nRe-run with --fix to un-wire the ${unusable.length} user-account reference(s).`);
  }
  await db.$disconnect();
})();
