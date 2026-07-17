// End-to-end test of the connector-login flow (the browser half of a browser-session/hybrid http
// connector) against a fake portal with a REAL browser — the login harvests a session, and the
// security-critical behaviour (only signing in / harvesting on an allowlisted host) can't be
// exercised by mocks.
//
//   node --test flows/connector-login.test.mjs        (from runner/browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "@playwright/test";
import connectorLogin, { harvestSession } from "./connector-login.mjs";

// A fake portal: /login shows email+password+Sign in. Signing in sets a `session` cookie AND stashes
// an `authToken` in localStorage, then reveals a "Signed in" banner.
function makePortal() {
  const html = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/login") {
      return res.end(html(`
        <h1>Vendor portal</h1>
        <label>Email <input aria-label="Email" id="email"></label>
        <label>Password <input aria-label="Password" id="pw" type="password"></label>
        <button onclick="
          document.cookie='session=COOKIE-SESSION-VALUE; path=/';
          window.localStorage.setItem('authToken','JWT-TOKEN-VALUE');
          document.getElementById('banner').textContent='Signed in';
        ">Sign in</button>
        <div id="banner"></div>`));
    }
    res.writeHead(404); res.end();
  });
  return { srv };
}

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${srv.address().port}`)));
}

const LOGIN_STEPS = [
  { type: "goto", url: "{{def.startUrl}}" },
  { type: "fill", target: { label: "Email" }, value: "{{secret.username}}" },
  { type: "fill", target: { label: "Password" }, value: "{{secret.password}}", secret: true },
  { type: "click", target: { role: "button", name: "Sign in" } },
  { type: "expect", target: { text: "Signed in" } },
];

async function drive(def, params = {}) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    return await connectorLogin({
      page, shot: async () => null, log: () => {},
      input: { username: "admin@vendor.com", password: "s3cr3t-portal-pw", params: { definition: def, allowAnyOrigin: true, ...params } },
    });
  } finally {
    await browser.close();
  }
}

test("logs in and harvests the named cookie", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    const def = { startUrl: `${origin}/login`, login: [{ type: "goto", url: `${origin}/login` }, ...LOGIN_STEPS.slice(1)], harvest: { cookies: ["session"] } };
    const r = await drive(def);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.session.cookies, { session: "COOKIE-SESSION-VALUE" });
  } finally { srv.close(); }
});

test("logs in and harvests a localStorage token", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    const def = { startUrl: `${origin}/login`, login: [{ type: "goto", url: `${origin}/login` }, ...LOGIN_STEPS.slice(1)], harvest: { storageKey: "authToken" } };
    const r = await drive(def);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.session.token, "JWT-TOKEN-VALUE");
  } finally { srv.close(); }
});

test("fails when a harvested cookie the login was supposed to set is missing", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    const def = { startUrl: `${origin}/login`, login: [{ type: "goto", url: `${origin}/login` }, ...LOGIN_STEPS.slice(1)], harvest: { cookies: ["nonexistent-cookie"] } };
    const r = await drive(def);
    assert.equal(r.ok, false);
    assert.match(r.error, /did not set the expected cookie\(s\): nonexistent-cookie/);
  } finally { srv.close(); }
});

test("refuses to type the credential into a login page on an unlisted host", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    // allowAnyOrigin OFF: startUrl is the fake portal but the login navigates to a DIFFERENT host.
    const def = { startUrl: `${origin}/login`, hosts: [new URL(origin).hostname], login: [{ type: "goto", url: "https://evil.example.com/login" }, ...LOGIN_STEPS.slice(1)], harvest: { cookies: ["session"] } };
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const r = await connectorLogin({ page, shot: async () => null, log: () => {}, input: { username: "u", password: "p", params: { definition: def } } });
      assert.equal(r.ok, false);
      assert.match(r.error, /not in the connector's allowlist/);
    } finally { await browser.close(); }
  } finally { srv.close(); }
});

test("harvestSession reads only the cookies it was asked for", async () => {
  // Unit-level: a fake page/context returning several cookies — only the named one comes back.
  const page = {
    context: () => ({ cookies: async () => [{ name: "session", value: "S" }, { name: "csrf", value: "C" }, { name: "other", value: "O" }] }),
  };
  const out = await harvestSession({ page, harvest: { cookies: ["session"] } });
  assert.deepEqual(out, { cookies: { session: "S" } });
});
