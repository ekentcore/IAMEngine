/* Diagnose a client's `zoom` secret end-to-end, the way the runner does — WITHOUT printing any
 * secret value. Resolves the fields from Delinea, flags hidden contamination (non-ASCII "smart
 * quotes", leading/trailing whitespace) that causes Zoom's invalid_client, and runs the real
 * Server-to-Server token request.
 *
 *   npx tsx scripts/check-zoom-secret.ts <client-slug>      (default: coretelligent)
 *
 * Run it on the APP SERVER (it needs DELINEA_BASE_URL/USER/PASSWORD in the environment).
 */
import { PrismaClient } from "@prisma/client";
import { delineaConfigFromEnv, delineaConfigured, resolveSecretFields } from "../lib/secrets/delinea";

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
  const slug = (process.argv[2] ?? "coretelligent").trim();
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) {
    console.error("✗ Delinea is not configured here — set DELINEA_BASE_URL/DELINEA_USER/DELINEA_PASSWORD (run this on the app server).");
    process.exit(1);
  }
  const secret = await db.secret.findFirst({ where: { name: "zoom", client: { slug } }, select: { externalId: true, client: { select: { name: true } } } });
  if (!secret) { console.error(`✗ no 'zoom' secret on client '${slug}'.`); process.exit(1); }
  console.log(`Client: ${secret.client.name} (${slug}) · zoom secret externalId=${secret.externalId || "(unset)"}`);

  const r = await resolveSecretFields(cfg, secret.externalId);
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
    console.log(`✓ SUCCESS — token issued. api_url=${body.api_url ?? "?"} · scopes ok. The stored secret is GOOD.`);
  } else {
    console.log(`✗ ${JSON.stringify({ error: body.error, reason: body.reason })}`);
    console.log("  If the field-health line above shows ⚠, fix that field (re-paste plain text). Otherwise the Client ID/Secret is wrong or stale — regenerate in Zoom.");
  }
  await db.$disconnect();
}

main().catch((e) => { console.error("✗", e instanceof Error ? e.message : e); process.exit(1); });
