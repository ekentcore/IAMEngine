// Diagnostic: log into Spanning Backup via Microsoft 365 SSO and probe for a "Back Up" trigger, so we
// can finalize the real spanning-force-sync flow (URL, selectors, factor type, and — the gold path —
// the INTERNAL backup request to replay instead of clicking). This is a DEV TOOL (runner/browser/
// scripts is in the bundle skip-list; it never ships to agents). It never logs secrets.
//
// Run from runner/browser (needs `npm install` + `npx playwright install chromium` first):
//   node scripts/spanning-login-test.mjs [--headed] [--secret <delineaId>] [--url <loginUrl>]
//
// Credentials — first source that resolves wins:
//   A) Direct env (quickest for a one-off test):
//        SPANNING_TEST_USER=svc@tenant.com  SPANNING_TEST_PASS=...  SPANNING_TEST_TOTP_SEED=<base32>
//   B) Delinea Secret Server (matches production): set --secret <id> and
//        DELINEA_BASE_URL, and either DELINEA_TOKEN (bearer) or DELINEA_USER + DELINEA_PASSWORD.
//        The secret's Username/Password fields are read; a TOTP is generated from a seed field
//        (TOTP / TOTPSeed / OTP Seed / ...). No seed → the script still tries and REPORTS the MFA it hits.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { totp } from "../lib/totp.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def = null) => { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] ?? true) : def; };
const HEADED = process.argv.includes("--headed");
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
const pick = (fields, names) => { for (const n of names) { const f = fields.find((x) => (x.slug || x.fieldName || "").toLowerCase().replace(/[^a-z0-9]+/g, "") === n.toLowerCase().replace(/[^a-z0-9]+/g, "")); if (f && f.itemValue) return f.itemValue; } return null; };
async function credsFromDelinea(id) {
  const base = process.env.DELINEA_BASE_URL, token = await delineaToken();
  const r = await fetch(`${base}/api/v1/secrets/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Delinea secret ${id} read failed (${r.status})`);
  const items = (await r.json()).items ?? [];
  return {
    username: pick(items, ["Username", "User", "Email", "AdminUser", "PortalUsername"]),
    password: pick(items, ["Password", "AdminPassword", "PortalPassword"]),
    totpSeed: pick(items, ["TOTPSeed", "TOTP", "OTPSeed", "MFASeed", "AuthenticatorSeed", "OneTimePasswordSeed", "2FASeed"]),
  };
}
function credsFromEnv() {
  const u = process.env.SPANNING_TEST_USER, p = process.env.SPANNING_TEST_PASS;
  if (!u || !p) return null;
  return { username: u, password: p, totpSeed: process.env.SPANNING_TEST_TOTP_SEED || null };
}

const redact = (s) => (s ? `<${String(s).length} chars>` : "(none)");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const log = [];
  const say = (m) => { log.push(`[${new Date().toISOString()}] ${m}`); console.log(m); };

  // 1. Resolve credentials (env first, then Delinea).
  let creds = credsFromEnv();
  if (!creds && SECRET_ID) creds = await credsFromDelinea(SECRET_ID);
  if (!creds) throw new Error("no credentials — set SPANNING_TEST_USER/PASS (+ SPANNING_TEST_TOTP_SEED), or --secret <id> with DELINEA_* configured");
  say(`credentials resolved: user=${creds.username} password=${redact(creds.password)} totpSeed=${creds.totpSeed ? "present" : "none"}`);

  // 2. Launch a persistent Chromium (device trust / "stay signed in" survive between runs).
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
