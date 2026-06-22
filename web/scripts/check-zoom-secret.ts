/* Diagnose a `zoom` secret end-to-end, the way the runner does — WITHOUT printing any secret value.
 * Resolves the fields from Delinea, flags hidden contamination (non-ASCII "smart quotes",
 * leading/trailing whitespace) that causes Zoom's invalid_client, and runs the real Server-to-Server
 * token request.
 *
 *   npx tsx scripts/check-zoom-secret.ts <client-slug>        (look the secret up by client)
 *   npx tsx scripts/check-zoom-secret.ts --secret=56730       (point straight at a Delinea secret id)
 *   npx tsx scripts/check-zoom-secret.ts 56730                (a bare number is treated as a secret id)
 *
 * Needs DELINEA_BASE_URL/USER/PASSWORD in the environment; loads them from the repo-root .env,
 * web/.env, or --env=<path>.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { delineaConfigFromEnv, delineaConfigured, resolveSecretFields } from "../lib/secrets/delinea";

// tsx (unlike `next`) does NOT auto-load .env, so DELINEA_* would be missing even when configured.
// Load .env from the usual spots — an explicit --env=PATH, the repo root (the "main folder"), and
// web/ — without overwriting anything already in the real environment. First file to set a key wins.
function loadEnvFiles(): void {
  const explicit = process.argv.find((a) => a.startsWith("--env="))?.slice("--env=".length);
  const candidates = [
    explicit && resolve(explicit),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),   // repo root when run from web/
    resolve(__dirname, "..", ".env"),        // web/.env
    resolve(__dirname, "..", "..", ".env"),  // repo root, relative to the script
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue; // don't override the real environment
      let val = m[2];
      const dq = val.match(/^"([^"]*)"/);
      const sq = val.match(/^'([^']*)'/);
      if (dq) val = dq[1];          // quoted: take what's inside (ignore any trailing comment)
      else if (sq) val = sq[1];
      else val = val.replace(/\s+#.*$/, ""); // unquoted: strip an inline "# comment" (dotenv-compatible)
      process.env[key] = val.trim();
    }
  }
}
loadEnvFiles();

const db = new PrismaClient();

// Case-insensitive pick over the resolved fields — mirrors Use-CtgZoomSecret in the runner.
function pick(fields: Record<string, string>, names: string[]): string | undefined {
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v) return v;
  }
  return undefined;
}

// Report a value's health without revealing it: length, trimming, and any non-ASCII char (with its
// position + code point — e.g. a U+2019 right single quote pasted in by autocorrect).
function inspect(label: string, value: string | undefined): string {
  if (!value) return `  ${label.padEnd(14)} MISSING`;
  const trimmed = value.trim();
  const ws = trimmed.length !== value.length ? " ⚠ leading/trailing whitespace" : "";
  const bad: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c < 0x20 || c > 0x7e) bad.push(`pos ${i}=U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  const nonAscii = bad.length ? ` ⚠ NON-ASCII (${bad.join(", ")})` : "";
  const ok = !ws && !nonAscii ? " ✓ clean" : "";
  return `  ${label.padEnd(14)} len=${value.length}${ok}${ws}${nonAscii}`;
}

async function main() {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    console.error("✗ Delinea is not configured — set DELINEA_BASE_URL/DELINEA_USER/DELINEA_PASSWORD in the app's .env");
    console.error("  (this script loads .env from the repo root, web/, and --env=<path>; pass --env=/path/to/.env if it's elsewhere).");
    process.exit(1);
  }

  // Resolve which Delinea secret to test, in priority order:
  //   --case=<num>   the EXACT secret the runner brokers for that case's client (the real test)
  //   --secret=<id> / bare number   a Delinea secret id, resolved directly
  //   <client-slug>  the client's 'zoom' secret externalId
  const positional = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const caseNum = process.argv.find((a) => a.startsWith("--case="))?.slice("--case=".length);
  const flagId = process.argv.find((a) => a.startsWith("--secret="))?.slice("--secret=".length)
    ?? process.argv.find((a) => a.startsWith("--id="))?.slice("--id=".length);
  const externalId = flagId ?? (positional && /^\d+$/.test(positional) ? positional : undefined);

  let secretId: string;
  if (caseNum) {
    const c = await db.caseRequest.findFirst({ where: { serviceNowCaseNumber: caseNum }, select: { clientId: true, client: { select: { slug: true, name: true } } } });
    if (!c) { console.error(`✗ no case with number '${caseNum}'.`); process.exit(1); }
    const sec = await db.secret.findFirst({ where: { name: "zoom", clientId: c.clientId }, select: { externalId: true } });
    if (!sec) { console.error(`✗ case ${caseNum} → client ${c.client.name} (${c.client.slug}) has NO 'zoom' secret wired — the runner can't broker it. Wire the zoom secret to Delinea #56730 on that client's Secrets panel.`); process.exit(1); }
    secretId = sec.externalId;
    console.log(`Case ${caseNum} → client ${c.client.name} (${c.client.slug}) → zoom secret externalId=${secretId || "(unset)"}`);
    if (!secretId) { console.error("  …but the externalId is BLANK — wire it to the Delinea secret (e.g. 56730)."); process.exit(1); }
  } else if (externalId) {
    secretId = externalId.trim();
    console.log(`Delinea secret #${secretId} (direct)`);
  } else {
    const slug = (positional ?? "coretelligent").trim();
    const secret = await db.secret.findFirst({ where: { name: "zoom", client: { slug } }, select: { externalId: true, client: { select: { name: true } } } });
    if (!secret) {
      console.error(`✗ no 'zoom' secret on client '${slug}'.`);
      const others = await db.secret.findMany({ where: { name: "zoom" }, select: { client: { select: { slug: true, name: true } } }, orderBy: { client: { name: "asc" } } });
      if (others.length) console.error(`  clients with a zoom secret: ${others.map((o) => `${o.client.slug} (${o.client.name})`).join(", ")}`);
      console.error("  …or test by case (--case=INC0841839) or a Delinea id (--secret=<id>).");
      process.exit(1);
    }
    secretId = secret.externalId;
    console.log(`Client: ${secret.client.name} (${slug}) · zoom secret externalId=${secretId || "(unset)"}`);
  }

  const r = await resolveSecretFields(cfg, secretId);
  if (!r.ok || !r.fields) { console.error(`✗ Delinea did not resolve the secret: ${r.error}`); process.exit(1); }
  console.log(`Resolved fields: ${Object.keys(r.fields).join(", ") || "(none)"}\n`);

  const clientId = pick(r.fields, ["ClientId", "ClientID", "Client ID", "Username"]);
  const clientSecret = pick(r.fields, ["ClientSecret", "Client Secret", "Secret", "ApiKey", "Key", "Password"]);
  const accountId = pick(r.fields, ["AccountId", "AccountID", "Account ID", "Account"]);
  console.log("Field health (values not shown):");
  console.log(inspect("Client ID", clientId));
  console.log(inspect("Client Secret", clientSecret));
  console.log(inspect("Account ID", accountId));

  if (!clientId || !clientSecret || !accountId) { console.error("\n✗ a required value is missing — fix the secret's fields."); process.exit(1); }

  // Use the values AS STORED (no trimming) so the test reflects exactly what the runner sends.
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  console.log(`\nZoom token request: HTTP ${res.status}`);
  if (res.ok) {
    console.log(`✓ SUCCESS — token issued. api_url=${body.api_url ?? "?"}. The stored secret is GOOD.`);
    const scopes = String(body.scope ?? "").split(/\s+/).filter(Boolean).sort();
    console.log(`\nGranted scopes (${scopes.length}):`);
    for (const s of scopes) console.log(`  ${s}`);
  } else {
    console.log(`✗ ${JSON.stringify({ error: body.error, reason: body.reason })}`);
    console.log("  If the field-health line above shows ⚠, fix that field (re-paste plain text). Otherwise the Client ID/Secret is wrong or stale — regenerate in Zoom.");
  }
  await db.$disconnect();
}

main().catch((e) => { console.error("✗", e instanceof Error ? e.message : e); process.exit(1); });
