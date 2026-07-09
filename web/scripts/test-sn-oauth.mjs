#!/usr/bin/env node
// Standalone test: switch ServiceNow auth from basic (username/password) to OAUTH 2.0
// (Resource Owner Password Credentials grant), then prove it works by writing a test work note
// to a User Management case you name.
//
//   node web/scripts/test-sn-oauth.mjs           # prompts for the case number
//   node web/scripts/test-sn-oauth.mjs UM0029378 # or pass it as an arg
//
// Reads from ../env.env (relative to this script): SN_INSTANCE_URL, SN_Access_Token_URL,
// SN_ClientID, SN_ClientSecret, SN_OAUTH_Pasword (the OAuth user's password), and the username
// from SN_USER / SN_USERNAME. Nothing is written until you confirm — it posts ONE work note.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(here, "..", "..", "env.env");
const TABLE = "/api/now/table/sn_customerservice_user_management";

// Minimal env.env loader: KEY=VALUE, quoted or bare; strips a trailing # comment on bare values
// (SN passwords contain $ & * etc., so quoted values are taken verbatim). Skips blanks / # / @ lines.
function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("@")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (v.startsWith('"')) { const e = v.indexOf('"', 1); v = e > 0 ? v.slice(1, e) : v.slice(1); }
    else { v = v.replace(/\s+#.*$/, "").trim(); }
    env[k] = v;
  }
  return env;
}

function need(env, key) {
  const v = env[key];
  if (!v) { console.error(`✗ missing ${key} in env.env`); process.exit(1); }
  return v;
}

// Flags to debug auth without editing env.env:
//   --basic      send client_id:client_secret as an Authorization: Basic header instead of in the body
//   --password   use the password (Resource Owner) grant instead of client_credentials — signs in as
//                SN_OAuth_User (fallback SN_USER) with SN_OAUTH_Pasword, still using the client id/secret
const FLAGS = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));

async function getOAuthToken(env, instance) {
  // ServiceNow's OAuth token endpoint is <instance>/oauth_token.do — fall back to that when
  // SN_Access_Token_URL isn't filled in (it's blank in env.env today).
  const tokenUrl = env.SN_Access_Token_URL || `${instance.replace(/\/$/, "")}/oauth_token.do`;
  const clientId = need(env, "SN_ClientID");
  const clientSecret = need(env, "SN_ClientSecret");
  const serviceUser = env.SN_OAuth_User || env.SN_USER || env.SN_USERNAME; // the account the OAuth app acts as

  // DEFAULT: client_credentials — authenticate with the client id + secret only. In ServiceNow the
  // service account (SN_OAuth_User, e.g. api_iam_engine) is BOUND to the OAuth app in the Application
  // Registry, not sent in the request. --password switches to the Resource Owner grant as a fallback.
  const body = new URLSearchParams();
  if (FLAGS.password) {
    if (!serviceUser) { console.error("✗ --password needs SN_OAuth_User (or SN_USER)"); process.exit(1); }
    body.set("grant_type", "password");
    body.set("username", serviceUser);
    body.set("password", need(env, "SN_OAUTH_Pasword"));
  } else {
    body.set("grant_type", "client_credentials");
  }
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (FLAGS.basic) { headers.Authorization = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"); }
  else { body.set("client_id", clientId); body.set("client_secret", clientSecret); }

  const grant = FLAGS.password ? `password (user ${serviceUser})` : "client_credentials";
  console.log(`→ token POST ${tokenUrl}  (grant=${grant} · client ${clientId} · creds in ${FLAGS.basic ? "Basic header" : "body"})`);
  if (!FLAGS.password && serviceUser) console.log(`  (the OAuth app should be bound to service account "${serviceUser}" in ServiceNow's Application Registry)`);
  const res = await fetch(tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok || !json?.access_token) {
    const err = json?.error ?? "";
    console.error(`✗ token request failed (HTTP ${res.status}): ${json ? JSON.stringify(json) : text.slice(0, 300)}`);
    if (err === "invalid_client") console.error("  → invalid_client: the CLIENT ID/SECRET are wrong (SN_ClientID / SN_ClientSecret).");
    else if (/unsupported_grant_type/.test(err)) console.error(`  → unsupported_grant_type: this OAuth app isn't enabled for ${grant}. In ServiceNow → System OAuth → Application Registry, open the app and enable the grant (for client_credentials, also bind it to the ${serviceUser ?? "service"} account). Or try --password.`);
    else if (/access_denied|server_error/.test(err)) console.error(`  → access_denied: ServiceNow accepted the client but refused a token. For client_credentials, the app usually isn't enabled for that grant or isn't tied to ${serviceUser ?? "a user"}. Try --basic, or --password (signs in as ${serviceUser ?? "SN_OAuth_User"} + SN_OAUTH_Pasword). Confirm the app is on THIS instance (${instance}).`);
    else console.error("  → check the OAuth app's grant type + the token URL.");
    process.exit(1);
  }
  console.log(`✓ got an access token (expires in ${json.expires_in ?? "?"}s, type ${json.token_type ?? "Bearer"})`);
  return json.access_token;
}

// Bearer-auth ServiceNow Table API call.
async function snApi(instance, token, method, path, { query, body } = {}) {
  const url = new URL(instance.replace(/\/$/, "") + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  if (!res.ok) throw new Error(`ServiceNow ${method} ${path} -> HTTP ${res.status}: ${json ? JSON.stringify(json.error ?? json) : text.slice(0, 300)}`);
  return json?.result;
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const instance = need(env, "SN_INSTANCE_URL");

  // 1) OAuth token (the conversion under test).
  const token = await getOAuthToken(env, instance);

  // 2) Which case? (first non-flag arg)
  let number = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!number) {
    const rl = createInterface({ input: stdin, output: stdout });
    number = (await rl.question("ServiceNow case number (e.g. UM0029378): ")).trim();
    rl.close();
  }
  if (!number) { console.error("✗ no case number given"); process.exit(1); }

  // 3) Resolve the case sys_id by number, using the OAuth token (proves reads work).
  console.log(`→ looking up ${number} on sn_customerservice_user_management …`);
  const rows = await snApi(instance, token, "GET", TABLE, { query: { sysparm_query: `number=${number}`, sysparm_fields: "sys_id,number", sysparm_limit: "1" } });
  const sysId = rows?.[0]?.sys_id;
  if (!sysId) { console.error(`✗ case ${number} not found (check the number / that it's a User Management record)`); process.exit(1); }
  console.log(`✓ found ${number} (sys_id ${sysId})`);

  // 4) Write a test work note (proves OAuth WRITES work too).
  const note = `iam-engine OAuth test note — posted ${new Date().toISOString()} via Resource Owner Password Credentials grant. Safe to ignore.`;
  console.log(`→ posting a test work note to ${number} …`);
  await snApi(instance, token, "PATCH", `${TABLE}/${sysId}`, { body: { work_notes: note } });
  console.log(`✓ work note posted to ${number}. OAuth read + write both succeeded — the conversion works.`);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
