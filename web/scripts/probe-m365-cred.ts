/* Live-test a client's m365-admin credential the EXACT way the runner does: the OAuth
 * client-credentials grant that Connect-MgGraph -ClientSecretCredential performs. A pass here means
 * the runner will connect; a failure returns Entra's own error code.
 *
 *   npx tsx scripts/probe-m365-cred.ts <client-slug>
 *   npx tsx scripts/probe-m365-cred.ts --all          # every wired m365-admin
 *
 * Never prints a credential value.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, resolveSecretFields } from "../lib/secrets/delinea";
import { classifyM365Credential, probeEntraClientCredentials, M365_APPID_FIELDS, M365_SECRET_FIELDS, M365_TENANT_FIELDS } from "../lib/secrets/m365-credential";

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

const pick = (f: Record<string, string>, names: string[]) => {
  const lower = new Map(Object.entries(f).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, ""), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase().replace(/\s+/g, ""));
    if (v && String(v).trim()) return String(v).trim();
  }
  return undefined;
};

const db = new PrismaClient();

(async () => {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) { console.error("✗ Delinea not configured"); process.exit(1); }
  const token = await getDelineaToken(cfg);

  const all = process.argv.includes("--all");
  const slug = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const secrets = await db.secret.findMany({
    where: {
      name: "m365-admin",
      externalId: { notIn: ["", "REPLACE_ME", "NOT_NEEDED"] },
      client: all ? { archivedAt: null } : { slug },
    },
    select: { externalId: true, client: { select: { name: true, slug: true, primaryDomain: true, emailDomain: true } } },
    orderBy: { client: { name: "asc" } },
  });
  if (!secrets.length) { console.error(`✗ no wired m365-admin secret${slug ? ` for '${slug}'` : ""}.`); process.exit(1); }

  let pass = 0, fail = 0;
  for (const s of secrets) {
    const r = await resolveSecretFields(cfg, s.externalId, undefined, token);
    if (!r.ok || !r.fields) { console.log(`✗ ${s.client.name}: Delinea did not resolve #${s.externalId} — ${r.error}`); fail++; continue; }

    const verdict = classifyM365Credential(r.fields);
    const appId = pick(r.fields, M365_APPID_FIELDS);
    const secret = pick(r.fields, M365_SECRET_FIELDS);
    const tenant = pick(r.fields, M365_TENANT_FIELDS) ?? s.client.emailDomain ?? s.client.primaryDomain;

    console.log(`\n${s.client.name} (${s.client.slug}) · Delinea #${s.externalId} "${r.label ?? "?"}"`);
    console.log(`  shape: ${verdict.kind} — ${verdict.reason}`);

    if (!appId || !secret || !tenant) { console.log("  live:  SKIPPED (missing app id / secret / tenant)"); fail++; continue; }
    const probe = await probeEntraClientCredentials(tenant, appId, secret);
    if (probe.ok) { console.log("  live:  ✓ AUTHENTICATED — the runner will connect with this credential"); pass++; }
    else {
      console.log(`  live:  ✗ REJECTED by Entra — ${probe.errorCode ?? probe.error}`);
      if (probe.hint) console.log(`         ${probe.hint}`);
      fail++;
    }
  }
  console.log(`\n${pass} authenticated, ${fail} failed, of ${secrets.length}.`);
  await db.$disconnect();
})();
