// Diagnostic: log into Spanning Backup via Microsoft 365 SSO and probe for a "Back Up" trigger, so we
// can finalize the real spanning-force-sync flow (URL, selectors, factor type, and — the gold path —
// the INTERNAL backup request to replay instead of clicking). This is a DEV TOOL (runner/browser/
// scripts is in the bundle skip-list; it never ships to agents). It never logs secrets.
//
// Run from runner/browser (needs `npm install` + `npx playwright install chromium` first):
//   node scripts/spanning-login-test.mjs --headed
//     → asks for the Delinea secret number, then pulls the username, password and TOTP seed from it
//       and drives the whole login. Nothing to copy by hand.
//   node scripts/spanning-login-test.mjs --headed --secret 12345    (skip the prompt)
//   ...also: [--url <loginUrl>] [--click]
//
// Delinea is the source of truth. It reads DELINEA_BASE_URL + DELINEA_USER/DELINEA_PASSWORD (or
// DELINEA_TOKEN) — the same config the app brokers with — and auto-loads them from web/.env, so
// normally there is nothing to set up.
//
// It reports WHICH field each value came from, because the portal login and the Spanning REST API
// credential live on the same secret: silently picking up a ClientID as the "username" fails as an
// unexplained bad-password error. Portal fields are preferred and the API-only fields are never used
// as a login — if that's all the secret has, it says so instead of guessing.
//   username : PortalUsername > AdminUser > Username > User > Email
//   password : PortalPassword > AdminPassword > Password
//   TOTP seed: TOTPSeed > TOTP > OTPSeed > MFASeed > ... (base32)
//
// SPANNING_TEST_USER / _PASS / _TOTP_SEED still work as an escape hatch for a credential that isn't
// in the vault yet (used only when --secret is absent).
// Playwright is imported LAZILY (below, after --check returns) so that validating a secret needs
// nothing but node — no npm install, no Chromium. --check has to work on any box.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { totp } from "../lib/totp.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def = null) => { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? true) : def; };
const HEADED = process.argv.includes("--headed");
// Resolve + validate the secret, then stop — no browser, no sign-in against the client's tenant.
const CHECK_ONLY = process.argv.includes("--check");
const LOGIN_URL = arg("--url", process.env.SPANNING_PORTAL_URL || "https://o365.spanningbackup.com/login.html");
const SECRET_ID = arg("--secret", process.env.SPANNING_TEST_SECRET || null);
const OUT = path.join(__dir, ".spanning-test-run");
const PROFILE = path.join(__dir, ".spanning-profile"); // persistent profile so MS remembers device trust

// ── tiny .env loader (web/.env) so DELINEA_* / SPANNING_TEST_* set there are available ────────────
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq <= 0) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile(path.resolve(__dir, "../../../web/.env"));

// ── Delinea (Secret Server) minimal REST client ───────────────────────────────────────────────────
async function delineaToken() {
  if (process.env.DELINEA_TOKEN) return process.env.DELINEA_TOKEN;
  const base = process.env.DELINEA_BASE_URL, user = process.env.DELINEA_USER, pass = process.env.DELINEA_PASSWORD;
  if (!base || !user || !pass) throw new Error("Delinea not configured (need DELINEA_BASE_URL + DELINEA_TOKEN, or DELINEA_USER/DELINEA_PASSWORD)");
  const r = await fetch(`${base}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", username: user, password: pass }) });
  if (!r.ok) throw new Error(`Delinea token failed (${r.status})`);
  return (await r.json()).access_token;
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const fieldName = (f) => f.slug || f.fieldName || "";

// Return BOTH the value and the field it came from. Provenance is the whole point: the portal login
// and the Spanning API credential live on the same secret, and if we silently pick up a ClientID as
// the "username" the login fails in a way that looks like a bad password.
function pickField(items, names) {
  for (const n of names) {
    const f = items.find((x) => norm(fieldName(x)) === norm(n));
    if (f && f.itemValue) return { value: f.itemValue, from: fieldName(f) };
  }
  return { value: null, from: null };
}

// PORTAL fields first. We deliberately do NOT fall back to ClientID/ClientSecret/ApiToken the way the
// production module does — those are the API credential; handing them to a browser login just fails
// obscurely. If only those exist we say so, loudly, instead of pretending we have a login.
const USER_FIELDS = ["PortalUsername", "AdminUser", "Username", "User", "Email"];
const PASS_FIELDS = ["PortalPassword", "AdminPassword", "Password"];
const SEED_FIELDS = ["TOTPSeed", "TOTP Seed", "TOTP", "OTPSeed", "OTP Seed", "MFASeed", "MFA Seed", "AuthenticatorSeed", "Authenticator Seed", "OneTimePasswordSeed", "TwoFactorSeed", "2FASeed", "otpauth"];
const API_ONLY_FIELDS = ["ClientID", "ClientId", "Client ID", "ClientSecret", "ApiToken", "ApiKey", "API Key", "AccessToken"];

async function credsFromDelinea(id) {
  const base = process.env.DELINEA_BASE_URL, token = await delineaToken();
  // autoComment satisfies Secret Server's "require a comment on view" policy — this IS a value view.
  // Without it the read 400s. Same call the app's resolveSecretFields makes.
  const comment = encodeURIComponent("iam-engine spanning login diagnostic");
  const r = await fetch(`${base}/api/v1/secrets/${encodeURIComponent(id)}?autoComment=${comment}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) throw new Error(`Delinea secret ${id} not found (404) — check the number`);
  if (r.status === 401 || r.status === 403) throw new Error(`Delinea denied access to secret ${id} (${r.status}) — grant this account Read on the secret`);
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    throw new Error(`Delinea secret ${id} read failed (${r.status}${d?.message ? ` — ${d.message}` : ""})`);
  }
  const body = await r.json();
  const items = body.items ?? [];

  const u = pickField(items, USER_FIELDS);
  const p = pickField(items, PASS_FIELDS);
  const s = pickField(items, SEED_FIELDS);

  return {
    secretName: body.name ?? `#${id}`,
    username: u.value, usernameFrom: u.from,
    password: p.value, passwordFrom: p.from,
    totpSeed: s.value, totpSeedFrom: s.from,
    // Everything on the secret, so a missing field tells you exactly what to add and what it's called.
    available: items.filter((f) => f.itemValue).map(fieldName),
    apiOnly: items.filter((f) => f.itemValue && API_ONLY_FIELDS.some((a) => norm(a) === norm(fieldName(f)))).map(fieldName),
  };
}

function credsFromEnv() {
  const u = process.env.SPANNING_TEST_USER, p = process.env.SPANNING_TEST_PASS;
  if (!u || !p) return null;
  return {
    secretName: "(env override)",
    username: u, usernameFrom: "SPANNING_TEST_USER",
    password: p, passwordFrom: "SPANNING_TEST_PASS",
    totpSeed: process.env.SPANNING_TEST_TOTP_SEED || null,
    totpSeedFrom: process.env.SPANNING_TEST_TOTP_SEED ? "SPANNING_TEST_TOTP_SEED" : null,
    available: [], apiOnly: [],
  };
}

// Ask for the Delinea secret number when it wasn't passed. Interactive by design — the whole point is
// "give it the secret number and it does the rest".
async function promptSecretId() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Delinea secret number for this client's `spanning` secret: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

const redact = (s) => (s ? `<${String(s).length} chars>` : "(none)");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const log = [];
  const say = (m) => { log.push(`[${new Date().toISOString()}] ${m}`); console.log(m); };

  // 1. Resolve credentials. Delinea is the source of truth — pass --secret <id>, or just run the
  //    script and it asks for the number. SPANNING_TEST_* stays as an explicit escape hatch for a
  //    credential that isn't in the vault yet.
  let creds = null;
  const envCreds = credsFromEnv();
  if (envCreds && !SECRET_ID) {
    creds = envCreds;
    say("credentials: SPANNING_TEST_* env override (no --secret given)");
  } else {
    const id = SECRET_ID || (await promptSecretId());
    if (!id) throw new Error("no Delinea secret number given");
    say(`reading Delinea secret ${id}…`);
    creds = await credsFromDelinea(id);
    say(`secret: ${creds.secretName}`);
  }

  // Provenance + a real preflight, so a misconfigured secret fails HERE with an actionable message
  // instead of as a mystery "wrong password" three screens into the Microsoft login.
  say(`  username : ${creds.username ?? "(MISSING)"}${creds.usernameFrom ? `   [field: ${creds.usernameFrom}]` : ""}`);
  say(`  password : ${redact(creds.password)}${creds.passwordFrom ? `   [field: ${creds.passwordFrom}]` : ""}`);
  say(`  totpSeed : ${creds.totpSeed ? "present" : "(MISSING)"}${creds.totpSeedFrom ? `   [field: ${creds.totpSeedFrom}]` : ""}`);

  if (!creds.username || !creds.password) {
    if (creds.available?.length) say(`  fields on this secret: ${creds.available.join(", ")}`);
    if (creds.apiOnly?.length) {
      say(`  NOTE: this secret carries API credentials (${creds.apiOnly.join(", ")}) but no portal login.`);
      say(`        Those are for the Spanning REST API — a browser sign-in needs a real M365 account.`);
    }
    throw new Error("the secret has no portal login — add PortalUsername + PortalPassword (an M365 account that can open the Spanning console)");
  }
  if (!creds.username.includes("@")) {
    say(`  WARNING: username "${creds.username}" is not an email address — the Microsoft sign-in expects a UPN.`);
    say(`           If this came from an API field, add an explicit PortalUsername to the secret.`);
  }
  if (!creds.totpSeed) {
    say("  NOTE: no TOTP seed — if the account prompts for a code the run stops there and screenshots it.");
    say("        Add TOTPSeed (base32) to the secret to complete MFA unattended.");
  } else {
    // Print the current code so you can eyeball it against the authenticator BEFORE spending a login.
    try {
      say(`  TOTP now : ${totp(creds.totpSeed)}  ← compare with your authenticator app; if it differs, the seed is wrong`);
    } catch (e) {
      throw new Error(`the TOTP seed on the secret is not valid base32 (${e.message}) — fix TOTPSeed`);
    }
  }

  // --check: validate the secret and stop. No browser, no sign-in attempt against the client's tenant.
  // Use it to confirm a client's `spanning` secret is wired for the browser flow before running it.
  if (CHECK_ONLY) {
    say("");
    say(`--check: secret is usable for the browser flow (portal login present${creds.totpSeed ? " + TOTP seed" : ", NO TOTP seed"}). No sign-in attempted.`);
    writeFileSync(path.join(OUT, "run.log"), log.join("\n"));
    return;
  }

  // 2. Launch a persistent Chromium (device trust / "stay signed in" survive between runs).
  // Lazy so --check needs no Playwright install (see the import note at the top).
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    throw new Error("Playwright isn't installed here — run `npm install && npx playwright install chromium` in runner/browser (not needed for --check)");
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: !HEADED, viewport: { width: 1360, height: 900 }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // Capture EVERY network request — the goal is to spot the internal "Back Up" call to replay.
  const net = [];
  page.on("request", (req) => { if (["POST", "PUT", "PATCH"].includes(req.method())) net.push({ method: req.method(), url: req.url(), t: Date.now() }); });

  const shot = async (label) => { const f = path.join(OUT, `${Date.now()}-${label}.png`); await page.screenshot({ path: f, fullPage: true }).catch(() => {}); say(`  screenshot: ${f}`); };

  try {
    say(`navigating to ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await shot("landing");

    // 2b. Console provider chooser → "Log In with Microsoft" (hands off to Microsoft 365 SSO).
    const msBtn = page.locator('a:has-text("Log In with Microsoft"), a:has-text("Sign in with Microsoft"), button:has-text("Log In with Microsoft"), a:has-text("Microsoft 365")').first();
    if (await msBtn.isVisible().catch(() => false)) {
      say('clicking "Log In with Microsoft"');
      await msBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
      await shot("after-provider-pick");
    }

    // 3. Microsoft 365 SSO. Selectors are the standard MS login field ids; the flow file uses the
    //    generic versions. We report what we actually see so the real flow can be finalized.
    const emailBox = page.locator('input[type="email"], input[name="loginfmt"], #i0116').first();
    if (await emailBox.isVisible().catch(() => false)) {
      say("entering username at the Microsoft sign-in");
      await emailBox.fill(creds.username);
      await page.locator('#idSIButton9, input[type="submit"], button:has-text("Next")').first().click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    const pwBox = page.locator('input[type="password"], #i0118').first();
    if (await pwBox.isVisible().catch(() => false)) {
      say("entering password");
      await pwBox.fill(creds.password);
      await page.locator('#idSIButton9, input[type="submit"], button:has-text("Sign in")').first().click().catch(() => {});
      await page.waitForTimeout(3000);
    }
    await shot("after-password");

    // 4. Second factor. TOTP code box (MS: input[name="otc"]) → fill from the seed. Push/number → report.
    const otcBox = page.locator('input[name="otc"], input[autocomplete="one-time-code"], input[id*="otc" i]').first();
    if (await otcBox.isVisible().catch(() => false)) {
      if (creds.totpSeed) {
        say("TOTP code prompt found — generating from the seed");
        await otcBox.fill(totp(creds.totpSeed));
        await page.locator('#idSubmit_SAOTCC_Continue, #idSIButton9, input[type="submit"], button:has-text("Verify")').first().click().catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        say("TOTP code prompt found but NO seed provided — stopping here (add SPANNING_TEST_TOTP_SEED)");
        await shot("mfa-totp-no-seed");
      }
    } else {
      const pushHint = await page.locator('text=/approve|number shown|open your authenticator|check your (phone|device)/i').first().isVisible().catch(() => false);
      if (pushHint) { say("!! login uses PUSH / number-matching MFA — cannot be automated headless"); await shot("mfa-push"); }
    }

    // 5. "Stay signed in?" — click Yes to persist device trust in the profile.
    const stay = page.locator('#idSIButton9, button:has-text("Yes")').first();
    if (await stay.isVisible().catch(() => false)) { say('answering "Stay signed in?" → Yes'); await stay.click().catch(() => {}); await page.waitForTimeout(2500); }
    await shot("after-login");

    say(`landed on: ${page.url()}`);

    // 6. Probe for a backup control (do NOT click in this diagnostic — we just want to see it + the
    //    network. Re-run with --click to actually trigger once we trust the selector).
    const backup = page.locator('button:has-text("Back Up"), button:has-text("Backup"), a:has-text("Back Up"), [data-action*="backup" i]').first();
    const backupVisible = await backup.isVisible().catch(() => false);
    say(backupVisible ? "found a Back Up control on this page" : "no Back Up control visible on the landing page (may need to navigate to a user/workload first)");
    if (backupVisible && process.argv.includes("--click")) {
      say("clicking Back Up (--click) and watching the network…");
      const before = net.length;
      await backup.click().catch(() => {});
      await page.waitForTimeout(4000);
      say(`new POST/PUT/PATCH requests after click: ${JSON.stringify(net.slice(before), null, 2)}`);
    }
    await shot("backup-probe");
  } catch (e) {
    say(`ERROR: ${e?.message ?? e}`);
    await shot("error");
  } finally {
    writeFileSync(path.join(OUT, "run.log"), log.join("\n"));
    writeFileSync(path.join(OUT, "network.json"), JSON.stringify(net, null, 2));
    say(`\nrun log + network capture written to ${OUT}`);
    say("Review network.json for a backup-looking POST (e.g. /backup, /backupJobs, /manualBackup, GraphQL) — that's the request to replay in the flow.");
    await ctx.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
