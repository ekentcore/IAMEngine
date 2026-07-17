/* Are the app-role ids we hand out actually the APPLICATION role ids Microsoft publishes?
 *
 *   npx tsx scripts/verify-graph-role-ids.ts             # check GRAPH_APP_ROLE_IDS against Graph
 *   npx tsx scripts/verify-graph-role-ids.ts --client core1390
 *   npx tsx scripts/verify-graph-role-ids.ts --lookup User-PasswordProfile.ReadWrite.All
 *
 * Why this exists: Microsoft publishes the SAME permission name twice — once as an application role
 * (servicePrincipal.appRoles) and once as a delegated scope (oauth2PermissionScopes) — with different
 * ids. Consenting a delegated id to an app-only credential grants NOTHING, but it looks granted: the
 * portal shows a green check and the call still returns "Insufficient privileges". A wrong id here is
 * therefore invisible until a customer grants it and their step still fails.
 *
 * Two real bugs this would have caught:
 *   - Domain.Read.All shipped as 7e05723c-… , which is the app role for Domain.ReadWrite.All. We asked
 *     admins for tenant domain WRITE to satisfy a read-only capability.
 *   - User-PasswordProfile.ReadWrite.All was nearly added as 56760768-… , its DELEGATED twin.
 *
 * graph-caps.test.ts pins these ids so a drift fails offline; this script is how you check the pin
 * against Microsoft itself, and how you find the id for a role you are adding. Read-only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { delineaConfigFromEnv, getDelineaToken, resolveSecretFields } from "../lib/secrets/delinea";
import { graphGet } from "../lib/secrets/graph-app-roles";
import { auditTargets } from "../lib/audits/m365-audit";
import { acquireGraphToken, pickField, M365_APPID_FIELDS, M365_SECRET_FIELDS, M365_TENANT_FIELDS } from "../lib/secrets/m365-credential";
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
const lookup = argv.filter((a, i) => argv[i - 1] === "--lookup");
const db = new PrismaClient();

type Role = { id?: string; value?: string };

(async () => {
  // Any wired tenant will do — the Graph service principal's role ids are the same everywhere.
  const cfg = delineaConfigFromEnv();
  const dToken = await getDelineaToken(cfg);
  const targets = await auditTargets(db, flag("--client"));
  let token: string | undefined;
  for (const t of targets) {
    const resolved = await resolveSecretFields(cfg, t.externalId, undefined, dToken);
    if (!resolved.ok || !resolved.fields) continue;
    const appId = pickField(resolved.fields, M365_APPID_FIELDS);
    const secret = pickField(resolved.fields, M365_SECRET_FIELDS);
    if (!appId || !secret) continue;
    const tenant = pickField(resolved.fields, M365_TENANT_FIELDS) ?? t.primaryDomain ?? "";
    const tok = await acquireGraphToken(tenant, appId, secret);
    if (tok.ok && tok.token) { token = tok.token; console.error(`reading Microsoft's Graph service principal via ${t.client}…\n`); break; }
  }
  if (!token) throw new Error("no usable credential to read the Graph service principal with");

  const sp = await graphGet<{ value: { appRoles: Role[]; oauth2PermissionScopes: Role[] }[] }>(
    token,
    `/servicePrincipals?$filter=appId eq '${GRAPH_RESOURCE_APP_ID}'&$select=appRoles,oauth2PermissionScopes`
  );
  if (!sp.ok) throw new Error(`could not read the Graph service principal: ${sp.status} ${sp.error}`);
  const appRoles = sp.body.value[0]?.appRoles ?? [];
  const scopes = sp.body.value[0]?.oauth2PermissionScopes ?? [];
  const byName = new Map(appRoles.map((r) => [String(r.value).toLowerCase(), String(r.id)]));
  const delegatedByName = new Map(scopes.map((r) => [String(r.value).toLowerCase(), String(r.id)]));
  const appRoleById = new Map(appRoles.map((r) => [String(r.id), String(r.value)]));
  const scopeById = new Map(scopes.map((r) => [String(r.id), String(r.value)]));

  if (lookup.length) {
    for (const name of lookup) {
      const app = byName.get(name.toLowerCase());
      const del = delegatedByName.get(name.toLowerCase());
      console.log(`${name}\n  application role id : ${app ?? "— not an application role —"}\n  delegated scope  id : ${del ?? "—"}\n`);
    }
    await db.$disconnect();
    return;
  }

  let bad = 0;
  for (const [name, id] of Object.entries(GRAPH_APP_ROLE_IDS)) {
    const want = byName.get(name.toLowerCase());
    if (want === id) { console.log(`✓ ${name}\n    ${id}`); continue; }
    bad++;
    // Name the mistake precisely — "wrong id" is not actionable, "that is the delegated twin" is.
    const isDelegated = scopeById.get(id);
    const isOtherRole = appRoleById.get(id);
    const because = isDelegated
      ? `that is the DELEGATED scope id for ${isDelegated} — it grants nothing to an app-only credential`
      : isOtherRole
        ? `that is the application role id for ${isOtherRole} — a different permission`
        : "no application role or delegated scope in Graph has that id";
    console.log(`✗ ${name}\n    ours:      ${id}\n    Microsoft: ${want ?? "— no such application role —"}\n    ${because}`);
  }
  console.log(`\n${Object.keys(GRAPH_APP_ROLE_IDS).length - bad}/${Object.keys(GRAPH_APP_ROLE_IDS).length} correct${bad ? ` · ${bad} WRONG — fix GRAPH_APP_ROLE_IDS in lib/secrets/graph-caps.ts` : ""}`);
  await db.$disconnect();
  if (bad) process.exit(1);
})().catch(async (e) => { console.error("ERR", (e as Error).message); await db.$disconnect(); process.exit(1); });
