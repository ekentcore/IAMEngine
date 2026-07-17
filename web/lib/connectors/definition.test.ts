import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorNeedsBrowser, definedLanes, validateConnectorDefinition, validateConnectorKey, type ConnectorDefinition } from "./definition";

// A browser-session (hybrid) http connector: a browser login harvests a session, then http ops run.
const sessionAuth = (over: Record<string, unknown> = {}) => ({
  type: "browser-session",
  secretName: "custom-vendor-portal",
  login: [
    { type: "goto", url: "https://api.vendor.com/login" },
    { type: "fill", target: { label: "Email" }, value: "{{secret.username}}" },
    { type: "fill", target: { label: "Password" }, value: "{{secret.password}}", secret: true },
    { type: "click", target: { role: "button", name: "Sign in" } },
    { type: "expect", target: { text: "Dashboard" } },
  ],
  harvest: { cookies: ["session"] },
  apply: { as: "cookie" },
  ...over,
});

const httpDef = (over: Record<string, unknown> = {}) => ({
  version: 1,
  kind: "http",
  baseUrl: "https://api.vendor.com/v1",
  hosts: ["api.vendor.com"],
  auth: { type: "bearer", secretName: "custom-vendor-api" },
  operations: {
    "find-user": {
      request: { method: "GET", path: "/users?email={{user.email}}" },
      expect: { status: [200] },
      extract: { userId: "results.0.id" },
    },
    "disable-user": {
      request: { method: "POST", path: "/users/{{vars.userId}}/deactivate" },
      expect: { status: [200, 204] },
    },
  },
  lanes: {
    offboard: [
      { op: "find-user" },
      { warnWhen: "!vars.userId", message: "no account found" },
      { op: "disable-user", when: "vars.userId" },
    ],
  },
  ...over,
});

const browserDef = (over: Record<string, unknown> = {}) => ({
  version: 1,
  kind: "browser",
  startUrl: "https://portal.vendor.com/login",
  credentials: { secretName: "custom-vendor-portal" },
  lanes: {
    offboard: [
      { type: "goto", url: "{{def.startUrl}}" },
      { type: "fill", target: { label: "Email" }, value: "{{secret.username}}" },
      { type: "fill", target: { label: "Password" }, value: "{{secret.password}}", secret: true },
      { type: "click", target: { role: "button", name: "Sign in" } },
      { type: "expect", target: { text: "Dashboard" } },
    ],
  },
  ...over,
});

test("a well-formed http definition validates and reports its secrets", () => {
  const v = validateConnectorDefinition("http", httpDef());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.secretNames, ["custom-vendor-api"]);
});

test("a well-formed browser definition validates", () => {
  const v = validateConnectorDefinition("browser", browserDef());
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.secretNames, ["custom-vendor-portal"]);
});

test("hosts allowlist is mandatory and must cover the baseUrl host", () => {
  assert.equal(validateConnectorDefinition("http", httpDef({ hosts: [] })).ok, false);
  assert.equal(validateConnectorDefinition("http", httpDef({ hosts: ["other.example.com"] })).ok, false);
});

test("http requires https everywhere", () => {
  assert.equal(validateConnectorDefinition("http", httpDef({ baseUrl: "http://api.vendor.com" })).ok, false);
  const v = validateConnectorDefinition("http", httpDef({
    operations: { bad: { request: { method: "GET", path: "http://api.vendor.com/x" } } },
    lanes: { offboard: [{ op: "bad" }] },
  }));
  assert.equal(v.ok, false);
});

test("an absolute operation path must hit an allowlisted host (rejected at save, not just on the runner)", () => {
  const foreign = validateConnectorDefinition("http", httpDef({
    operations: { steal: { request: { method: "POST", path: "https://evil.example.com/collect" } } },
    lanes: { offboard: [{ op: "steal" }] },
  }));
  assert.equal(foreign.ok, false);
  assert.match(foreign.errors.join("\n"), /not in the connector's hosts allowlist/);

  // A template in the host portion can't be resolved statically — left to the runner, not a save error.
  const templatedHost = validateConnectorDefinition("http", httpDef({
    hosts: ["api.vendor.com"],
    operations: { op: { request: { method: "GET", path: "https://{{config.region}}.vendor.com/x" }, expect: { status: [200] } } },
    lanes: { offboard: [{ op: "op" }] },
  }));
  assert.equal(templatedHost.ok, true, templatedHost.errors.join("; "));
});

test("templates fail closed: unknown roots and undeclared secrets are errors", () => {
  const badRoot = validateConnectorDefinition("http", httpDef({
    operations: { op: { request: { method: "GET", path: "/x?e={{env.HOME}}" } } },
    lanes: { offboard: [{ op: "op" }] },
  }));
  assert.equal(badRoot.ok, false);
  assert.match(badRoot.errors.join("\n"), /unknown root "env"/);

  const badSecret = validateConnectorDefinition("http", httpDef({
    operations: { op: { request: { method: "GET", path: "/x", headers: { "X-Key": "{{secret.other-secret.password}}" } } } },
    lanes: { offboard: [{ op: "op" }] },
  }));
  assert.equal(badSecret.ok, false);
  assert.match(badSecret.errors.join("\n"), /does not declare/);
});

test("lane steps must reference known operations and legal conditions", () => {
  const unknownOp = validateConnectorDefinition("http", httpDef({ lanes: { offboard: [{ op: "nope" }] } }));
  assert.equal(unknownOp.ok, false);
  const badCond = validateConnectorDefinition("http", httpDef({
    lanes: { offboard: [{ op: "find-user", when: "vars.x == 1" }] },
  }));
  assert.equal(badCond.ok, false);
});

test("browser steps fail closed on unknown types and ambiguous targets", () => {
  const unknownType = validateConnectorDefinition("browser", browserDef({
    lanes: { offboard: [{ type: "evaluate", value: "window.x" }] },
  }));
  assert.equal(unknownType.ok, false);

  const twoTargets = validateConnectorDefinition("browser", browserDef({
    lanes: { offboard: [{ type: "click", target: { css: "#a", text: "A" } }] },
  }));
  assert.equal(twoTargets.ok, false);

  const noTarget = validateConnectorDefinition("browser", browserDef({
    lanes: { offboard: [{ type: "fill", value: "x" }] },
  }));
  assert.equal(noTarget.ok, false);
});

test("a definition must define at least one lane and match its kind", () => {
  assert.equal(validateConnectorDefinition("http", httpDef({ lanes: {} })).ok, false);
  assert.equal(validateConnectorDefinition("browser", httpDef()).ok, false); // kind mismatch
  assert.equal(validateConnectorDefinition("scim", httpDef()).ok, false);
});

test("http secret templates must name a field (secret.<name>.<field>), not just the secret", () => {
  const twoSeg = validateConnectorDefinition("http", httpDef({
    operations: { op: { request: { method: "GET", path: "/x", headers: { "X-Key": "{{secret.custom-vendor-api}}" } } } },
    lanes: { offboard: [{ op: "op" }] },
  }));
  assert.equal(twoSeg.ok, false);
  assert.match(twoSeg.errors.join("\n"), /secret\.<name>\.<field>/);
});

test("oauth2 tokenUrl host must be in the allowlist (it receives the client secret)", () => {
  const offHost = validateConnectorDefinition("http", httpDef({
    auth: { type: "oauth2-client-credentials", secretName: "custom-vendor-api", tokenUrl: "https://login.evil.com/token" },
  }));
  assert.equal(offHost.ok, false);
  assert.match(offHost.errors.join("\n"), /tokenUrl host/);

  const onHost = validateConnectorDefinition("http", httpDef({
    hosts: ["api.vendor.com", "login.vendor.com"],
    auth: { type: "oauth2-client-credentials", secretName: "custom-vendor-api", tokenUrl: "https://login.vendor.com/token" },
  }));
  assert.equal(onHost.ok, true, onHost.errors.join("; "));
});

test("header auth requires both header and a template-checked valueTemplate", () => {
  const missing = validateConnectorDefinition("http", httpDef({
    auth: { type: "header", secretName: "custom-vendor-api", header: "X-Api-Key" },
  }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /valueTemplate is required/);

  const badTemplate = validateConnectorDefinition("http", httpDef({
    auth: { type: "header", secretName: "custom-vendor-api", header: "X-Api-Key", valueTemplate: "{{secret.custom-vendor-api}}" },
  }));
  assert.equal(badTemplate.ok, false); // two-seg secret in the header template

  const ok = validateConnectorDefinition("http", httpDef({
    auth: { type: "header", secretName: "custom-vendor-api", header: "X-Api-Key", valueTemplate: "{{secret.custom-vendor-api.password}}" },
  }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("defaults.headers and step message templates are validated at save (same rules as the runner)", () => {
  const badDefault = validateConnectorDefinition("http", httpDef({
    defaults: { headers: { "X-Env": "{{env.SECRET}}" } },
  }));
  assert.equal(badDefault.ok, false);
  assert.match(badDefault.errors.join("\n"), /defaults\.headers\.X-Env: template .* unknown root/);

  const badMessage = validateConnectorDefinition("http", httpDef({
    lanes: { offboard: [{ op: "find-user" }, { warnWhen: "!vars.userId", message: "{{secret.undeclared}}" }] },
  }));
  assert.equal(badMessage.ok, false);
});

// ── browser-session (hybrid) auth ────────────────────────────────────────────

test("a well-formed browser-session http connector validates", () => {
  const v = validateConnectorDefinition("http", httpDef({ auth: sessionAuth() }));
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test("browser-session login steps are held to the same rules as browser lanes", () => {
  const unknownType = validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ login: [{ type: "evaluate", value: "x" }] }) }));
  assert.equal(unknownType.ok, false);
  const twoTargets = validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ login: [{ type: "click", target: { css: "#a", text: "A" } }] }) }));
  assert.equal(twoTargets.ok, false);
  const empty = validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ login: [] }) }));
  assert.equal(empty.ok, false);
});

test("a login goto host that isn't in the allowlist is rejected at save", () => {
  const v = validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ login: [{ type: "goto", url: "https://login.evil.com/x" }] }) }));
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /goto host \(login\.evil\.com\) is not in the connector's hosts allowlist/);
});

test("harvest must set exactly one of cookies / storageKey", () => {
  assert.equal(validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: {} }) })).ok, false);
  assert.equal(validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: { cookies: ["s"], storageKey: "t" } }) })).ok, false);
  assert.equal(validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: { storageKey: "authToken" }, apply: { as: "bearer" } }) })).ok, true);
});

test("apply.as='cookie' needs harvested cookies; bearer/header take a single token", () => {
  // cookie apply with only a storageKey → nothing to send as Cookie
  assert.equal(validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: { storageKey: "t" }, apply: { as: "cookie" } }) })).ok, false);
  // header apply without a header name
  assert.equal(validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: { storageKey: "t" }, apply: { as: "header" } }) })).ok, false);
  const okHeader = validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: { storageKey: "t" }, apply: { as: "header", header: "X-Auth" } }) }));
  assert.equal(okHeader.ok, true, okHeader.errors.join("; "));
  // bearer with 2 cookies is ambiguous — which one is the token?
  const twoCookiesBearer = validateConnectorDefinition("http", httpDef({ auth: sessionAuth({ harvest: { cookies: ["a", "b"] }, apply: { as: "bearer" } }) }));
  assert.equal(twoCookiesBearer.ok, false);
  assert.match(twoCookiesBearer.errors.join("\n"), /takes a single token/);
});

test("connectorNeedsBrowser: browser kind, and http-with-browser-session, need the browser harness", () => {
  assert.equal(connectorNeedsBrowser("browser", browserDef()), true);
  assert.equal(connectorNeedsBrowser("http", httpDef()), false);
  assert.equal(connectorNeedsBrowser("http", httpDef({ auth: sessionAuth() })), true);
  // tolerant of a raw/foreign definition shape (the claim path calls it on the stored JSON column)
  assert.equal(connectorNeedsBrowser("http", null), false);
  assert.equal(connectorNeedsBrowser("http", { auth: { type: "bearer" } }), false);
});

test("connector keys are custom- prefixed slugs", () => {
  assert.equal(validateConnectorKey("custom-notion"), null);
  assert.equal(validateConnectorKey("custom-a1-b2"), null);
  assert.notEqual(validateConnectorKey("m365"), null);
  assert.notEqual(validateConnectorKey("custom-"), null);
  assert.notEqual(validateConnectorKey("custom-No_Caps"), null);
  assert.notEqual(validateConnectorKey("spanning-force-sync"), null);
});

test("definedLanes drives catalog supports flags", () => {
  const lanes = definedLanes(httpDef() as unknown as ConnectorDefinition);
  assert.deepEqual(lanes, { onboard: false, offboard: true, test: false });
});
