// Flow: spanning-console-setup
// ---------------------------------------------------------------------------------------------
// Sign into the Spanning Backup admin console (Microsoft-365 SSO) and HARVEST the API token, which the
// app then vaults as the client's `spanning` API credential. This is the setup analog of
// spanning-force-sync (which uses the SAME M365 SSO login); here we don't sync — we read the API key so
// onboarding/offboarding can use the Spanning API without a human copying it out of the console.
//
// HAR-DERIVED (data/apisetup-<service>-<region>.spanningbackup.com.har, a real capture of the live
// flow): once signed in, the token is created/read by TWO same-origin API calls — NO fragile
// Settings-UI clicking:
//   1. GET  /api/apiUser/token  -> `false` (JSON) when no token exists yet, or the token OBJECT when one
//      does: { msUserPrincipalName, token }.
//   2. POST /api/apiUser/token  (content-type: application/json, body "{}") -> { msUserPrincipalName,
//      token }. NO XSRF/CSRF header — same-origin cookies (present after login) are enough.
// `msUserPrincipalName` is the Spanning API username (the login email); `token` is the API key.
//
// The M365 SSO sign-in reuses the shared, live-verified helper runner/browser/lib/ms-sso-login.mjs
// (same machinery spanning-force-sync relies on) — headless: email -> password -> MFA/OTP.
//
// input:  { username, password, params: { service?, region?, apiUrl?, consoleUrl?, signInOnly?,
//                                          otp?, otpCode?, totpSeed? } }  (creds NEVER logged)
// result: { ok:true, session:{ token, username } }  — the harvested token/username ride the `session`
//         field (the ONLY rich channel run-flow.mjs + Coretelligent.Browser pass through unmodified);
//         the runner repackages it into the `Credentials` note-property the app vaults then scrubs. On
//         signInOnly the token is omitted. { ok:false, error, evidence } on failure (incl. the
//         "a token already exists but its value isn't returned — paste or regenerate it" manual case).
import { signInMicrosoft } from "../lib/ms-sso-login.mjs";

const SPANNING_SERVICES = new Set(["o365", "google"]);
const SPANNING_REGIONS = new Set(["us", "eu", "ap", "uk", "ca"]);
const DEFAULT_CONSOLE_HOST = "https://o365-us.spanningbackup.com";

// The Spanning admin-console origin that serves the same-origin /api/apiUser/token endpoint:
//   https://<service>-<region>.spanningbackup.com     (service o365|google, region us|eu|ap|uk|ca)
// Resolution order, most explicit first:
//   1. params.service + params.region     (the dispatch derives these).
//   2. params.apiUrl  — the API base is https://<service>-api-<region>.spanningbackup.com; drop the
//      "-api-" segment to get the console host (o365-api-us -> o365-us).
//   3. params.consoleUrl — an explicit override; use its origin.
//   4. the o365/us default.
// Returns an origin (scheme + host, no trailing slash).
function resolveConsoleHost(input) {
  const p = input?.params ?? {};
  const service = String(p.service ?? "").trim().toLowerCase();
  const region = String(p.region ?? "").trim().toLowerCase();
  if (SPANNING_SERVICES.has(service) && SPANNING_REGIONS.has(region)) {
    return `https://${service}-${region}.spanningbackup.com`;
  }
  const apiUrl = String(p.apiUrl ?? "").trim();
  if (apiUrl) {
    try {
      const host = new URL(apiUrl.match(/^https?:\/\//i) ? apiUrl : `https://${apiUrl}`).hostname;
      // o365-api-us.spanningbackup.com -> o365-us.spanningbackup.com
      const consoleHost = host.replace(/-api-/i, "-");
      if (/\.spanningbackup\.com$/i.test(consoleHost)) return `https://${consoleHost}`;
    } catch { /* fall through */ }
  }
  const consoleUrl = String(p.consoleUrl ?? "").trim();
  if (consoleUrl) {
    try {
      return new URL(consoleUrl.match(/^https?:\/\//i) ? consoleUrl : `https://${consoleUrl}`).origin;
    } catch { /* fall through */ }
  }
  return DEFAULT_CONSOLE_HOST;
}

// The provider chooser on the Spanning login page before MS SSO takes over ("Log In with Microsoft").
const MS_PROVIDER_SEL =
  'button:has-text("Microsoft"), a:has-text("Log In with Microsoft"), a:has-text("Microsoft 365"), a:has-text("Sign in with Microsoft"), [data-provider="microsoft"]';

// Same-origin GET of the current API token. Returns the parsed JSON: `false` / null when none exists
// yet, the token object ({ token, msUserPrincipalName }) when one does, or { __error } on a transport
// failure. Runs INSIDE the page so it rides the authenticated console cookies — never logs the value.
async function getExistingToken(page) {
  return page.evaluate(async () => {
    try {
      const r = await fetch("/api/apiUser/token", { credentials: "include", headers: { accept: "application/json" } });
      if (!r.ok) return { __error: `GET /api/apiUser/token -> HTTP ${r.status}` };
      return await r.json();
    } catch (e) {
      return { __error: String((e && e.message) || e) };
    }
  });
}

// Same-origin POST that creates a fresh token. Body is "{}" with content-type application/json; no
// XSRF/CSRF header (same-origin cookies suffice, per the HAR). Returns the created token object or
// { __error }. Only called when NO token exists — a POST when one does would REGENERATE (invalidating
// the existing key everywhere), which we must never do.
async function createToken(page) {
  return page.evaluate(async () => {
    try {
      const r = await fetch("/api/apiUser/token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "include",
        body: "{}",
      });
      if (!r.ok) return { __error: `POST /api/apiUser/token -> HTTP ${r.status}` };
      return await r.json();
    } catch (e) {
      return { __error: String((e && e.message) || e) };
    }
  });
}

// Harvest the token via the console's own API (see the HAR notes above). `consoleHost` is the origin
// we signed into and must be on for the same-origin fetches to carry the session cookies.
async function harvestApiToken(page, shot, log, reportStage, consoleHost) {
  // Guarantee we're on the console ORIGIN (the SSO redirect can leave us mid-hop) so the relative
  // fetches below hit the authenticated console, not login.microsoftonline.com.
  try {
    if (new URL(page.url()).origin !== consoleHost) {
      await page.goto(consoleHost, { waitUntil: "domcontentloaded" }).catch(() => {});
    }
  } catch {
    await page.goto(consoleHost, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  log("reading the current Spanning API token via the console API");
  const existing = await getExistingToken(page);

  if (existing && typeof existing === "object" && existing.__error) {
    return { ok: false, error: `signed in, but could not read the Spanning API token: ${existing.__error}`, evidence: await shot("token-read-failed") };
  }

  // A token already exists — REUSE it (never POST: regenerating invalidates the current key everywhere).
  if (existing && typeof existing === "object" && typeof existing.token === "string" && existing.token.trim()) {
    reportStage("harvest");
    log("an API token already exists — reusing it (not regenerating)"); // the VALUE is never logged
    return { ok: true, session: { token: existing.token.trim(), username: existing.msUserPrincipalName ?? null } };
  }

  // No token yet (`false` or null) — create one.
  if (existing === false || existing == null) {
    reportStage("create");
    log("no Spanning API token exists yet — creating one");
    const created = await createToken(page);
    if (created && typeof created === "object" && created.__error) {
      return { ok: false, error: `could not create the Spanning API token: ${created.__error}`, evidence: await shot("token-create-failed") };
    }
    if (created && typeof created === "object" && typeof created.token === "string" && created.token.trim()) {
      reportStage("harvest");
      return { ok: true, session: { token: created.token.trim(), username: created.msUserPrincipalName ?? null } };
    }
    return { ok: false, error: "created a Spanning API token but the console did not return its value — read it from the Spanning console (Settings → API Token) and paste it manually", evidence: await shot("token-create-empty") };
  }

  // Truthy, but no `.token` field — a token exists whose value the API won't return. Do NOT POST (that
  // would regenerate and break the live key). Hand it back for manual entry.
  return {
    ok: false,
    error: "a Spanning API token already exists but the console did not return its value. Paste the existing token manually, or explicitly regenerate it in the Spanning console (Settings → API Token) — regenerating invalidates the current key everywhere — and re-run.",
    evidence: await shot("token-value-withheld"),
  };
}

export default async function spanningConsoleSetup({ page, shot, input, log, reportStage }) {
  const stage = typeof reportStage === "function" ? reportStage : () => {};
  const signInOnly = input?.params?.signInOnly === true;
  const consoleHost = resolveConsoleHost(input);

  stage("signin");
  try {
    log("opening the Spanning admin console");
    await page.goto(consoleHost, { waitUntil: "domcontentloaded" }).catch(() => {});
    // Provider chooser → Microsoft, then the shared MS SSO login handles username/password/MFA.
    const provider = page.locator(MS_PROVIDER_SEL).first();
    if (await provider.isVisible().catch(() => false)) {
      log('choosing "Log In with Microsoft"');
      await provider.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  } catch (e) {
    return { ok: false, error: `could not open the Spanning console: ${e?.message ?? e}`, evidence: await shot("open-failed") };
  }

  const login = await signInMicrosoft({ page, shot, input, log });
  if (!login.ok) return login;

  if (signInOnly) {
    log("sign-in test succeeded (no changes made)");
    return { ok: true };
  }

  return harvestApiToken(page, shot, log, stage, consoleHost);
}
