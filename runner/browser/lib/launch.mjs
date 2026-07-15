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
  // From here the browser IS launched — if context/page creation throws, close it or the Chromium
  // process leaks (the caller has no handle yet, so its finally can't clean up).
  let context, page;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultNavigationTimeout(navTimeoutMs);
    context.setDefaultTimeout(actionTimeoutMs);
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
