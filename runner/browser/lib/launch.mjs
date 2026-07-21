// Shared Playwright Chromium launcher for the runner's browser flows. Headless, with sane timeouts
// and a screenshot-on-failure helper. Kept dependency-light: only @playwright/test's `chromium`.
//
// Nothing here logs credentials. Flows receive `input` (which may carry a password) but this module
// never prints it.
import os from "node:os";
import path from "node:path";

// @playwright/test is imported LAZILY (inside launch), not at module load. A STATIC top-level import
// of a package that is missing or half-installed — e.g. node_modules/@playwright/test present as an
// empty directory after an interrupted `npm install` — throws during ESM linking, before ANY of our
// code runs and before run-flow's try/catch or its uncaught-error handlers exist. That crashes node
// with a bare "Node.js vX" banner and no result on stdout, which the PowerShell side can only report
// as the opaque "produced no result". Deferring the import turns that into a catchable launch error
// with an actionable message. (Root cause of the fleet-wide Spanning force-sync outage, 2026-07-15.)
async function loadChromium() {
  try {
    const pw = await import("@playwright/test");
    if (!pw?.chromium) throw new Error("@playwright/test loaded but exports no `chromium`");
    return pw.chromium;
  } catch (e) {
    throw new Error(`Playwright is not installed on this host (@playwright/test could not be loaded) — run \`npm install\` in runner/browser, then \`npx playwright install chromium\`: ${e?.message ?? e}`);
  }
}

// Conservative defaults — a portal login + one action shouldn't need more than this, and a runner
// job that hangs on a wedged browser is worse than one that fails fast with a clear timeout.
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 20_000;

// Turn a Playwright Chromium UA ("...HeadlessChrome/149.0.0.0...") into a normal-Chrome one by
// swapping only the "HeadlessChrome" token, preserving the real platform + version. Returns null
// when there is nothing to change (a UA with no HeadlessChrome token, or a falsy input), so callers
// can leave the default UA untouched rather than force one. See the launch() comment for WHY this
// matters (Google serves a dead OAuth token to HeadlessChrome UAs).
export function deHeadlessUserAgent(ua) {
  if (!ua || !ua.includes("HeadlessChrome")) return null;
  return ua.replace(/HeadlessChrome/g, "Chrome");
}

// Launch a headless Chromium and hand back { browser, context, page } plus a `shot()` helper that
// screenshots to a temp file (for evidence-on-failure). The caller MUST call close() in a finally.
export async function launch({ navTimeoutMs = DEFAULT_NAV_TIMEOUT_MS, actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS } = {}) {
  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (e) {
    // The most common cause is a missing browser binary — make the fix actionable.
    const hint = /Executable doesn.t exist|Failed to launch|install/i.test(String(e?.message))
      ? " — run `npx playwright install chromium` on this host"
      : "";
    throw new Error(`could not launch Chromium${hint}: ${e?.message ?? e}`);
  }
  // De-headless the User-Agent. Playwright's Chromium reports "HeadlessChrome/<ver>" in its UA, and
  // at least one provider (Google's OAuth token endpoint) uses that token as an automation signal:
  // a sign-in from a "HeadlessChrome" UA still succeeds and returns an authorization code, but the
  // code redeems for an access token with expires_in:0 — dead on arrival, so every subsequent API
  // call 401s ("invalid authentication credentials"). Proven live on Drive Capital's Google Workspace
  // OAuth sign-in, 2026-07-21: identical flow, HeadlessChrome UA -> expires_in 0; UA with that token
  // replaced by "Chrome" -> expires_in 3599. `--headless=new` does NOT help (its UA still says
  // HeadlessChrome). We read the browser's OWN UA and only swap the one token, so the real platform
  // and Chromium version stay correct on any runner OS (Mac/Windows/Linux) — no brittle hardcoded UA.
  // Applied to every flow: a non-headless-looking UA can only help other portals (e.g. MS SSO), never
  // hurt. `navigator.webdriver` is likewise scrubbed as a second, cheap automation tell.
  let uaOverride;
  try {
    const probeCtx = await browser.newContext();
    const probePage = await probeCtx.newPage();
    const natural = await probePage.evaluate(() => navigator.userAgent);
    uaOverride = deHeadlessUserAgent(natural) ?? undefined;
    await probeCtx.close();
  } catch {
    // Best-effort: if we can't read the UA, fall through with the default (headless) UA rather than
    // fail the launch — most flows don't care, and this keeps a UA-read hiccup from breaking them.
    uaOverride = undefined;
  }

  // From here the browser IS launched — if context/page creation throws, close it or the Chromium
  // process leaks (the caller has no handle yet, so its finally can't clean up).
  let context, page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...(uaOverride ? { userAgent: uaOverride } : {}) });
    context.setDefaultNavigationTimeout(navTimeoutMs);
    context.setDefaultTimeout(actionTimeoutMs);
    await context.addInitScript(() => {
      try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch { /* ignore */ }
    });
    page = await context.newPage();
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    throw new Error(`could not open a browser context: ${e?.message ?? e}`);
  }

  // Screenshot to a temp path for failure evidence. Best-effort — never throws (evidence is a nice
  // to have; a screenshot failure must not mask the real error).
  async function shot(label = "failure") {
    try {
      const safe = String(label).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
      const file = path.join(os.tmpdir(), `ctg-browser-${safe}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
      return file;
    } catch {
      return null;
    }
  }

  async function close() {
    try { await context.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
  }

  return { browser, context, page, shot, close };
}
