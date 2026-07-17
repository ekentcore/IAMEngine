// End-to-end test of the generic connector-steps flow against a fake portal, with a REAL browser —
// the same approach as spanning-force-sync.test.mjs (the security-critical behaviour is origin
// crossing + typing a secret, which mocks can't exercise).
//
//   node --test flows/connector-steps.test.mjs        (from runner/browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "@playwright/test";
import connectorSteps from "./connector-steps.mjs";

// A fake portal: /login has an email + password box and a "Sign in" button that reveals a search box
// and a "Deactivate" button, which flips a banner to "User deactivated".
function makePortal() {
  const state = { got: {} };
  const html = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/login") {
      return res.end(html(`
        <h1>Vendor portal</h1>
        <label>Email <input aria-label="Email" id="email"></label>
        <label>Password <input aria-label="Password" id="pw" type="password"></label>
        <button onclick="document.getElementById('app').style.display='block'">Sign in</button>
        <div id="app" style="display:none">
          <input placeholder="Search users" aria-label="Search users">
          <button onclick="document.getElementById('banner').textContent='User deactivated'">Deactivate</button>
          <div id="banner"></div>
        </div>`));
    }
    res.writeHead(404); res.end();
  });
  return { srv, state };
}

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${srv.address().port}`)));
}

async function drive(def, params) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const shot = async () => null;
    const log = () => {};
    return await connectorSteps({
      page, shot, log,
      input: { username: "admin@vendor.com", password: "s3cr3t-portal-pw", params: { definition: def, allowAnyOrigin: true, ...params } },
    });
  } finally {
    await browser.close();
  }
}

test("runs a full offboard lane against a real portal", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    const def = {
      version: 1, kind: "browser", startUrl: `${origin}/login`,
      lanes: {
        offboard: [
          { type: "goto", url: "{{def.startUrl}}" },
          { type: "fill", target: { label: "Email" }, value: "{{secret.username}}" },
          { type: "fill", target: { label: "Password" }, value: "{{secret.password}}", secret: true },
          { type: "click", target: { role: "button", name: "Sign in" } },
          { type: "fill", target: { placeholder: "Search users" }, value: "{{user.email}}" },
          { type: "click", target: { role: "button", name: "Deactivate" } },
          { type: "expect", target: { text: "User deactivated" } },
        ],
      },
    };
    const r = await drive(def, { lane: "offboard", user: { email: "jane@medipost.com" } });
    assert.equal(r.ok, true, r.error);
    assert.match(r.message, /7 step/);
  } finally {
    srv.close();
  }
});

test("fails when an expect target never appears", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    const def = {
      version: 1, kind: "browser", startUrl: `${origin}/login`,
      lanes: { offboard: [
        { type: "goto", url: "{{def.startUrl}}" },
        { type: "expect", target: { text: "This text is never on the page" }, timeoutMs: 800 },
      ] },
    };
    const r = await drive(def, { lane: "offboard", user: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /expected .* to appear/);
  } finally {
    srv.close();
  }
});

test("refuses to navigate outside the host allowlist (and never types the secret there)", async () => {
  const { srv } = makePortal();
  const origin = await listen(srv);
  try {
    // startUrl is the fake portal, but the goto targets a DIFFERENT host with allowAnyOrigin OFF.
    const def = {
      version: 1, kind: "browser", startUrl: `${origin}/login`, hosts: [new URL(origin).hostname],
      lanes: { offboard: [
        { type: "goto", url: "https://evil.example.com/login" },
        { type: "fill", target: { label: "Password" }, value: "{{secret.password}}", secret: true },
      ] },
    };
    // Note: allowAnyOrigin defaults off here (we pass it only in `drive`); override it back to false.
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const r = await connectorSteps({
        page, shot: async () => null, log: () => {},
        input: { username: "admin@vendor.com", password: "s3cr3t-portal-pw", params: { definition: def, lane: "offboard", user: {} } },
      });
      assert.equal(r.ok, false);
      assert.match(r.error, /not in the connector's allowlist/);
    } finally {
      await browser.close();
    }
  } finally {
    srv.close();
  }
});

test("refuses a non-https navigation when the allowlist is live (no credential over cleartext)", async () => {
  // allowAnyOrigin OFF → the host+scheme check is live. An http:// goto to an otherwise-listed host
  // must be refused: a browser connector must never type a portal credential over cleartext.
  const def = {
    version: 1, kind: "browser", startUrl: "https://portal.vendor.com/login", hosts: ["portal.vendor.com"],
    lanes: { offboard: [{ type: "goto", url: "http://portal.vendor.com/login" }] },
  };
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const r = await connectorSteps({
      page, shot: async () => null, log: () => {},
      input: { username: "admin@vendor.com", password: "s3cr3t-portal-pw", params: { definition: def, lane: "offboard", user: {} } },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /not in the connector's allowlist/);
  } finally { await browser.close(); }
});

test("unknown step type fails closed", async () => {
  const def = {
    version: 1, kind: "browser", startUrl: "https://x.example.com/login",
    lanes: { offboard: [{ type: "evaluate", value: "alert(1)" }] },
  };
  const r = await drive(def, { lane: "offboard", user: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown step type 'evaluate'/);
});
