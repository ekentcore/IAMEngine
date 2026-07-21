// Flow: google-dwd-grant
// ---------------------------------------------------------------------------------------------
// With the Workspace super-admin signed in, grant (or reconcile) domain-wide delegation for a service
// account in the Admin console's "API controls -> Domain-wide delegation" panel
// (https://admin.google.com/ac/owl/domainwidedelegation). If a row for the service account's client ID
// already exists, open it and reconcile scopes to the UNION of what's there and what's requested; if
// not, "Add new" -> paste the client ID + comma-joined scopes -> Authorize. Then read the table back
// and print DWD_GRANTED:<saClientId> ONLY when the row shows every requested scope; otherwise return a
// non-ok result with WARN lines so the app falls back to a manual grant.
//
// Reuses signInGoogle from google-oauth-signin.mjs — the exact same email/password/TOTP sign-in — so
// the two Google browser flows sign in identically. The scope parse/union/compare logic lives in the
// pure helpers below (unit-tested); only the DOM reading/clicking is browser-bound.
//
// LIVE-VALIDATION PENDING: like the OAuth flow, the browser path here is validated live in Task 12
// (no Chromium in this environment). Selectors follow the Admin console's stable structure in the
// resilient-selector style of this directory; the pure helpers are exercised by the unit tests.
import { signInGoogle } from "./google-oauth-signin.mjs";
import { waitForCondition } from "../lib/ms-sso-login.mjs";

const DWD_URL = "https://admin.google.com/ac/owl/domainwidedelegation";

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (unit-tested; no browser)
// -------------------------------------------------------------------------------------------------

// Split a scopes cell (comma / whitespace / newline separated) into trimmed, deduped scopes. Google's
// scopes are URLs with no internal commas or whitespace, so splitting on [\s,]+ is safe.
export function parseScopeList(text) {
  if (!text) return [];
  const out = [];
  for (const s of String(text).split(/[\s,]+/)) {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// The union to authorize when reconciling an existing row: everything already present, then only the
// genuinely-new requested scopes (deduped, existing order preserved).
export function unionScopes(existing, requested) {
  const out = [];
  for (const s of [...(existing || []), ...(requested || [])]) {
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Is every requested scope present in the row (order-independent)?
export function hasAllScopes(present, requested) {
  const set = new Set(present || []);
  return (requested || []).every((s) => set.has(s));
}

// Exactly the requested scopes NOT present — for the WARN line when a grant can't be confirmed.
export function missingScopes(present, requested) {
  const set = new Set(present || []);
  return (requested || []).filter((s) => !set.has(s));
}

// The Admin console's "OAuth scopes" box takes a comma-delimited list.
export function formatScopesForInput(scopes) {
  return (scopes || []).join(",");
}

// The flow's success line — the app treats the DWD job succeeding as confirmation; this line makes the
// grant auditable in the run report.
export function formatDwdGrantedLine(saClientId) {
  return `DWD_GRANTED:${saClientId}`;
}

// -------------------------------------------------------------------------------------------------
// BROWSER PATH (LIVE-VALIDATION PENDING)
// -------------------------------------------------------------------------------------------------

const SEL = {
  // Rows in the DWD table; each carries the numeric client ID and its authorized scopes.
  row: 'table tr, [role="row"]',
  addNew: 'button:has-text("Add new"), a:has-text("Add new"), button:has-text("Add")',
  clientIdInput: 'input[aria-label*="Client ID" i], input[name*="client" i], input[type="text"]',
  scopesInput: 'textarea, input[aria-label*="scope" i], input[aria-label*="OAuth" i]',
  authorize: 'button:has-text("Authorize"), button:has-text("Save"), button[type="submit"]',
  // The scopes cell / expanded panel for a row (best-effort text read).
  scopesCell: 'td, [role="cell"]',
};

// Read the authorized scopes for saClientId out of the table, or null if no row is found. Best-effort:
// finds the row whose text contains the client ID and parses its scopes cell text with parseScopeList.
async function readGrantedScopes(page, saClientId) {
  try {
    const rows = page.locator(SEL.row);
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const text = await row.innerText().catch(() => "");
      if (text && text.includes(saClientId)) {
        // The row text is "<clientId>\t<scope, scope, ...>" — strip the client ID, parse the rest.
        const scopeText = text.split(saClientId).slice(1).join(" ");
        return parseScopeList(scopeText);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export default async function googleDwdGrant({ page, shot, input, log }) {
  const saClientId = input?.params?.saClientId ?? null;
  const requested = Array.isArray(input?.params?.scopes) ? input.params.scopes.filter(Boolean) : [];
  if (!saClientId) {
    return { ok: false, error: "no service-account client ID was provided (params.saClientId)." };
  }
  if (requested.length === 0) {
    return { ok: false, error: "no scopes were provided (params.scopes) — nothing to authorize." };
  }

  // 1. Navigate to the DWD panel (this bounces through Google sign-in when not authenticated).
  try {
    log("navigating to the domain-wide delegation panel");
    await page.goto(DWD_URL, { waitUntil: "domcontentloaded" });
  } catch (e) {
    return { ok: false, error: `could not reach the domain-wide delegation panel: ${e?.message ?? e}`, evidence: await shot("nav") };
  }

  // 2. Sign in if Google intercepted with its sign-in page (same machinery as the OAuth flow).
  if (/accounts\.google\.com/i.test(page.url())) {
    const signIn = await signInGoogle({ page, shot, input, log });
    if (!signIn.ok) return signIn;
    // Land back on the admin console.
    await waitForCondition(page, () => /admin\.google\.com/i.test(page.url()), 30_000);
    if (!/admin\.google\.com/i.test(page.url())) {
      try { await page.goto(DWD_URL, { waitUntil: "domcontentloaded" }); } catch { /* handled below */ }
    }
  }

  // 3. Reconcile. Read any existing row, compute the union to authorize, then add-new or edit.
  try {
    const existing = await readGrantedScopes(page, saClientId);
    const toAuthorize = unionScopes(existing || [], requested);
    if (existing && hasAllScopes(existing, requested)) {
      log("service account already has every requested scope — nothing to add");
      return { ok: true, message: formatDwdGrantedLine(saClientId) };
    }

    // Open the "Add new" / edit dialog and fill client ID + the (union of) scopes. Google's Add-new
    // dialog also serves edits idempotently: re-authorizing an existing client ID with the union
    // supersets its scopes rather than duplicating the row.
    const addBtn = page.locator(SEL.addNew).first();
    if (await addBtn.isVisible().catch(() => false)) {
      log(existing ? "editing the existing delegation row (reconciling scopes)" : "adding a new delegation");
      await addBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    const idField = page.locator(SEL.clientIdInput).first();
    if (await idField.isVisible().catch(() => false)) {
      await idField.fill(String(saClientId)).catch(() => {});
    }
    const scopeField = page.locator(SEL.scopesInput).first();
    if (!(await scopeField.isVisible().catch(() => false))) {
      return { ok: false, error: "WARN could not find the OAuth-scopes input in the delegation dialog — VERIFY the Admin-console selectors against the live console; grant the delegation manually meanwhile.", evidence: await shot("no-scopes-input") };
    }
    await scopeField.fill(formatScopesForInput(toAuthorize)).catch(() => {});
    await page.locator(SEL.authorize).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2500);

    // 4. Read the table back — confirm EVERY requested scope is present before claiming success.
    let confirmed = null;
    await waitForCondition(page, async () => {
      confirmed = await readGrantedScopes(page, saClientId);
      return confirmed != null && hasAllScopes(confirmed, requested);
    }, 15_000);

    if (confirmed && hasAllScopes(confirmed, requested)) {
      return { ok: true, message: formatDwdGrantedLine(saClientId) };
    }
    const missing = missingScopes(confirmed || [], requested);
    return {
      ok: false,
      error: `WARN the domain-wide delegation grant could not be confirmed for client ${saClientId} — ${missing.length ? `missing scope(s): ${missing.join(", ")}` : "the row did not appear with the requested scopes"}. Grant it manually in the Admin console (API controls -> Domain-wide delegation).`,
      evidence: await shot("dwd-not-confirmed"),
    };
  } catch (e) {
    return { ok: false, error: `WARN could not complete the domain-wide delegation grant: ${e?.message ?? e}`, evidence: await shot("dwd-error") };
  }
}
