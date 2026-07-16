// End-to-end test of the REAL spanning-force-sync flow against a fake Spanning + Microsoft SSO portal.
//
// Why a fake portal rather than mocks: this flow had never been executed by anything — not once, in a
// test or in production (the only real attempt died at the MFA prompt). Its bugs were all in the parts
// mocks can't reach: the redirect chain through Microsoft SSO, the "Stay signed in?" interstitial that
// parked the browser on login.microsoftonline.com, and the origin check that then reported a perfectly
// good sign-in as a failure. So we serve a portal that reproduces that exact chain and drive the real
// flow file through it with a real browser.
//
//   node --test flows/spanning-force-sync.test.mjs        (from runner/browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "@playwright/test";
import spanningForceSync from "./spanning-force-sync.mjs";

const USER = "admin@contoso.com";
const PASS = "correct-horse";
const CODE = "654321";

// A fake that mirrors the real chain — and mirrors its ORIGINS. Microsoft SSO is served by a SEPARATE
// server (a different origin, exactly as login.microsoftonline.com is), because the bugs this flow
// actually had were all origin-crossing ones: the browser stranded on the Microsoft origin after the
// "Stay signed in?" prompt, and the origin gate then rejected a perfectly good sign-in.
//
//   console: /login.html -> "Log In with Microsoft" (cross-origin) -> MS: user -> pass -> TOTP ->
//   "Stay signed in?" -> back to the console origin, which serves POST /api/sync + /api/tenantCache.
//
// It also serves the OTP-mint endpoint the PRODUCTION MFA path calls (mintOtp fetches it from node).
function makePortal({ kmsi = true, syncCompletesAfter = 1, badPassword = false } = {}) {
  const state = { syncCalls: 0, polls: 0, jobId: 17849871, signedIn: false, sawCode: null, otpMints: 0 };
  const html = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
  const mk = (handler) => http.createServer(handler);
  const reply = (res) => (code, body, type = "text/html") => { res.writeHead(code, { "content-type": type }); res.end(body); };

  let msOrigin = "";
  let consoleOrigin = "";

  const consoleSrv = mk((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = reply(res);
    if (url.pathname === "/login.html") {
      return send(200, html(`<h1>Spanning Backup</h1><a href="${msOrigin}/ms/user">Log In with Microsoft</a>`));
    }
    if (url.pathname === "/console") {
      state.signedIn = true;
      // The console has its own "Sync now" button — a KMSI locator that matched on button TEXT could
      // mis-click here, so keep it present.
      return send(200, html(`<h1>Spanning admin console</h1><button id="sync">Sync now</button>`));
    }
    if (url.pathname === "/api/sync" && req.method === "POST") {
      if (!state.signedIn) return send(401, JSON.stringify({ error: "not signed in" }), "application/json");
      state.syncCalls++;
      return send(200, JSON.stringify({ id: state.jobId, tenant_id: 15529, status: "PENDING" }), "application/json");
    }
    if (url.pathname.startsWith("/api/tenantCache/")) {
      state.polls++;
      return send(200, JSON.stringify({ id: state.jobId, status: state.polls >= syncCompletesAfter ? "COMPLETE" : "PENDING" }), "application/json");
    }
    // The app's credential endpoint: mints a fresh one-time password at the MFA box (production path).
    if (url.pathname === "/otp" && req.method === "POST") {
      state.otpMints++;
      return send(200, JSON.stringify({ otpCode: CODE, otpRemainingSeconds: 28 }), "application/json");
    }
    return send(404, "nope");
  });

  const msSrv = mk((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = reply(res);
    if (url.pathname === "/ms/user") {
      // Microsoft's sign-in is a SINGLE-PAGE app, and this page mirrors that shape deliberately: the
      // password view is ALREADY in the document while the username step is on screen, parked in an
      // `aria-hidden="true"` container with its input collapsed to a ~10x13 box (verified against the
      // live login.microsoftonline.com, 2026-07-16). An earlier fake served the two views as separate
      // pages, so the flow's `isVisible()` check on the password field looked correct here while it was
      // broken in production — the bug lived in the exact gap between this fake and the real thing.
      return send(200, html(`<form action="/ms/pass" method="get">
        <input type="email" name="loginfmt" id="i0116"><input type="submit" id="idSIButton9" value="Next"></form>
        <div aria-hidden="true"><input type="password" name="passwd" id="i0118"
          style="width:10px;height:13px"></div>`));
    }
    if (url.pathname === "/ms/pass") {
      return send(200, html(`<form action="/ms/mfa" method="get">
        <input type="password" name="passwd" id="i0118"><input type="submit" id="idSIButton9" value="Sign in"></form>`));
    }
    if (url.pathname === "/ms/mfa") {
      if (badPassword) {
        // Microsoft RE-RENDERS the sign-in form on its error page — the generic submit button
        // (#idSIButton9) is present right next to the error. A KMSI locator keyed on that id would
        // re-submit the password here and burn a second failed sign-in against the admin account.
        return send(200, html(`<div id="passwordError">Your account or password is incorrect.</div>
          <form action="/ms/mfa" method="get"><input type="password" name="passwd" id="i0118">
          <input type="submit" id="idSIButton9" value="Sign in"></form>`));
      }
      return send(200, html(`<form action="/ms/kmsi" method="get">
        <input type="tel" name="otc" id="idTxtBx_SAOTCC_OTC"><input type="submit" id="idSubmit_SAOTCC_Continue" value="Verify"></form>`));
    }
    if (url.pathname === "/ms/kmsi") {
      state.sawCode = url.searchParams.get("otc");
      if (!kmsi) { res.writeHead(302, { location: `${consoleOrigin}/console` }); return res.end(); }
      // The interstitial that stranded the flow on the Microsoft origin. Note the KMSI checkbox — the
      // marker the flow keys on, rather than the generic button id.
      return send(200, html(`<h1>Stay signed in?</h1>
        <form action="${consoleOrigin}/console" method="get">
          <input type="checkbox" name="DontShowAgain" id="KmsiCheckboxField">
          <input type="submit" id="idSIButton9" value="Yes"></form>`));
    }
    return send(404, "nope");
  });

  return {
    state,
    async listen() {
      await new Promise((r) => consoleSrv.listen(0, "127.0.0.1", r));
      await new Promise((r) => msSrv.listen(0, "127.0.0.1", r));
      consoleOrigin = `http://127.0.0.1:${consoleSrv.address().port}`;
      msOrigin = `http://localhost:${msSrv.address().port}`; // a DIFFERENT origin (host differs)
      return { consoleOrigin, msOrigin };
    },
    close() { consoleSrv.close(); msSrv.close(); },
  };
}

// `otp` (an OtpRequest spec) is what PRODUCTION dispatches — the flow mints the code from the app at
// the MFA box. `otpCode` is the legacy pre-minted fallback. Default to the production path.
async function runFlow(portalUrl, { otpCode = null, otpUrl = null, password = PASS, allowAnyOrigin = true, signInOnly = false } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  process.env.SPANNING_PORTAL_URL = `${portalUrl}/login.html`;
  process.env.SPANNING_POLL_MS = "6000"; // don't sit through the production window in a test
  // The origin gate is pinned to spanningbackup.com; a stand-in console must opt in explicitly. Tests
  // that assert the gate REJECTS a host leave this off.
  if (allowAnyOrigin) process.env.SPANNING_ALLOW_ANY_ORIGIN = "1";
  else delete process.env.SPANNING_ALLOW_ANY_ORIGIN;
  const params = { email: "new.user@contoso.com" };
  if (signInOnly) params.signInOnly = true;
  if (otpCode) params.otpCode = otpCode;
  if (otpUrl) params.otp = { url: otpUrl, token: "t", agentId: "a", secretName: "spanning" };
  try {
    return {
      result: await spanningForceSync({
        page,
        shot: async () => null,
        log: (m) => logs.push(m),
        input: { username: USER, password, params },
      }),
      logs,
    };
  } finally {
    delete process.env.SPANNING_ALLOW_ANY_ORIGIN;
    await browser.close();
  }
}

async function withPortal(opts, fn) {
  const portal = makePortal(opts);
  const { consoleOrigin } = await portal.listen();
  try { return await fn(consoleOrigin, portal.state); } finally { portal.close(); }
}

// The whole point: sign in through the Microsoft chain (a DIFFERENT origin) and fire the sync — using
// the PRODUCTION MFA path, where the code is minted from the app at the MFA box.
test("signs in through Microsoft SSO, mints the MFA code, and fires the console's own /api/sync", async () => {
  await withPortal({}, async (url, state) => {
    const { result } = await runFlow(url, { otpUrl: `${url}/otp` });
    assert.equal(result.ok, true, `flow failed: ${result.error}`);
    assert.equal(state.otpMints, 1, "the code must be minted at the MFA prompt (production path)");
    assert.equal(state.sawCode, CODE, "the minted code must reach the Microsoft prompt");
    assert.equal(state.syncCalls, 1, "POST /api/sync must be fired exactly once");
    assert.match(result.message, /completed/i);
  });
});

// REGRESSION (UM0029840): the password box of Microsoft's pre-rendered, aria-hidden password view
// reports `isVisible() === true` while the USERNAME step is still on screen — it has a real, if tiny,
// 10x13 bounding box, which is all Playwright's isVisible() asks for. The flow therefore concluded the
// password box was already up, SKIPPED the "Next" click, typed the password into the offscreen field,
// and spent its one submit click on "Next" — landing on the password view with the password pre-filled
// and never submitted. It then waited out the 60s redirect timeout and blamed the credentials
// ("still on the login page") on a login whose password and MFA were both fine.
//
// The give-away in production was the evidence screenshot: the password sat TYPED in the box with no
// Microsoft error next to it. A rejected password re-renders with #passwordError; an untouched,
// pre-filled box means the form was never submitted at all.
test("clicks through the username step instead of typing the password into Microsoft's hidden view", async () => {
  await withPortal({}, async (url, state) => {
    const { result } = await runFlow(url, { otpUrl: `${url}/otp` });
    assert.equal(result.ok, true, `flow failed: ${result.error}`);
    assert.doesNotMatch(String(result.error ?? ""), /still on the login page/i);
    assert.equal(state.syncCalls, 1, "a good password must reach the console and fire the sync");
  });
});

// REGRESSION: Microsoft's "Stay signed in?" page sits between a successful MFA and the redirect back.
// Unanswered, the browser parks on the Microsoft origin and the flow bailed with "wrong-origin" — a
// fully successful sign-in reported as a failure. This is what blocked the very first real run.
test("answers the 'Stay signed in?' interstitial instead of stranding on the Microsoft origin", async () => {
  await withPortal({ kmsi: true }, async (url, state) => {
    const { result, logs } = await runFlow(url, { otpUrl: `${url}/otp` });
    assert.equal(result.ok, true, `flow failed: ${result.error}`);
    assert.ok(logs.some((l) => /Stay signed in/i.test(l)), "should have answered the KMSI prompt");
    assert.equal(state.syncCalls, 1);
  });
});

// The legacy pre-minted code still works (older runners pass otpCode).
test("still accepts a pre-minted code (legacy runner path)", async () => {
  await withPortal({}, async (url, state) => {
    const { result } = await runFlow(url, { otpCode: CODE });
    assert.equal(result.ok, true, `flow failed: ${result.error}`);
    assert.equal(state.otpMints, 0, "no mint call when a code was supplied");
    assert.equal(state.sawCode, CODE);
    assert.equal(state.syncCalls, 1);
  });
});

// A still-PENDING sync is NOT a failure — we kicked it off; the caller re-checks.
test("reports a still-pending sync as started (with a recheck window), not as a failure", async () => {
  await withPortal({ syncCompletesAfter: 9999 }, async (url, state) => {
    const { result } = await runFlow(url, { otpUrl: `${url}/otp` });
    assert.equal(result.ok, true);
    assert.equal(state.syncCalls, 1);
    assert.match(result.message, /started/i);
    assert.ok(result.retryAfterMinutes > 0, "a pending sync must ask the app to re-check");
  });
});

// REGRESSION: Microsoft RE-RENDERS the sign-in form on its error page, so a KMSI locator keyed on the
// generic #idSIButton9 would re-submit the password — burning a second failed sign-in against the
// admin account (halving the smart-lockout runway) and destroying the diagnostic. The error must be
// read BEFORE any KMSI click, and the sign-in must be submitted exactly once.
test("surfaces Microsoft's sign-in error without re-submitting the password", async () => {
  await withPortal({ badPassword: true }, async (url, state) => {
    const { result, logs } = await runFlow(url, { password: "wrong", otpUrl: `${url}/otp` });
    assert.equal(result.ok, false);
    assert.match(result.error, /Microsoft rejected the sign-in/i);
    assert.match(result.error, /incorrect/i);
    assert.ok(!logs.some((l) => /Stay signed in/i.test(l)), "must NOT mistake the error page for a KMSI prompt");
    assert.equal(state.syncCalls, 0, "must never fire the sync after a failed sign-in");
  });
});

// The CONNECTION TEST (signInOnly): prove the console sign-in works — the whole M365 SSO chain, the
// Delinea-minted MFA code, the KMSI interstitial, the origin gate — and then change NOTHING. It runs
// this same flow rather than a bespoke copy so that what it verifies is what the force-sync will do;
// the one thing it must never do is fire a real sync at a client's tenant.
test("signInOnly proves the console login end to end and fires no sync", async () => {
  await withPortal({}, async (url, state) => {
    const { result } = await runFlow(url, { otpUrl: `${url}/otp`, signInOnly: true });
    assert.equal(result.ok, true, `sign-in check failed: ${result.error}`);
    assert.equal(state.otpMints, 1, "the MFA code must still be minted — that's a thing the test exists to prove");
    assert.equal(state.sawCode, CODE, "the minted code must reach the Microsoft prompt");
    assert.equal(state.signedIn, true, "must actually reach the console");
    assert.equal(state.syncCalls, 0, "a CONNECTION TEST must never trigger a real sync");
    assert.match(result.message, /signed in/i);
  });
});

// A signInOnly run must still be held to the origin gate: reporting "console sign-in OK" after landing
// somewhere that isn't Spanning would be a green light on a broken (or hostile) portal config.
test("signInOnly still refuses an untrusted origin rather than reporting a good sign-in", async () => {
  await withPortal({}, async (url, state) => {
    const { result } = await runFlow(url, { otpUrl: `${url}/otp`, signInOnly: true, allowAnyOrigin: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /not a Spanning console origin/i);
    assert.equal(state.syncCalls, 0);
  });
});

// A bad password must fail the sign-in CHECK too — this is the failure the test exists to catch early,
// and it must be reported as such rather than swallowed.
test("signInOnly surfaces a rejected password instead of reporting success", async () => {
  await withPortal({ badPassword: true }, async (url, state) => {
    const { result } = await runFlow(url, { password: "wrong", otpUrl: `${url}/otp`, signInOnly: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /Microsoft rejected the sign-in/i);
    assert.equal(state.syncCalls, 0);
  });
});

// The origin gate is the guard on an AUTHENTICATED, credentialed POST. It must be anchored to a
// constant — not derived from the configured URL — so a misconfigured or hostile portal is refused.
test("refuses to fire the authenticated sync at an untrusted origin", async () => {
  await withPortal({}, async (url, state) => {
    // No SPANNING_ALLOW_ANY_ORIGIN: the stand-in console is not under spanningbackup.com.
    const { result } = await runFlow(url, { otpUrl: `${url}/otp`, allowAnyOrigin: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /not a Spanning console origin/i);
    assert.equal(state.syncCalls, 0, "the credentialed POST must never leave the browser");
  });
});
