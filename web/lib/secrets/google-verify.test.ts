import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  DWD_SCOPES,
  signSaJwt,
  keyPemFromBase64Json,
  probeGoogleDirectory,
  probeWithDwdRetry,
} from "./google-verify";

const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (b: unknown, status = 400) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function makeRsaKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerB64, payloadB64] = jwt.split(".");
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  return { header, payload };
}

test("DWD_SCOPES is the verbatim ordered scope list", () => {
  assert.deepEqual(DWD_SCOPES, [
    "https://www.googleapis.com/auth/admin.directory.user",
    "https://www.googleapis.com/auth/admin.directory.group",
    "https://www.googleapis.com/auth/admin.directory.orgunit",
    "https://www.googleapis.com/auth/admin.directory.user.security",
  ]);
});

test("signSaJwt produces a JWT that verifies against the RSA public key with RS256", () => {
  const { privateKey, publicKey } = makeRsaKeyPair();
  const jwt = signSaJwt({
    saEmail: "sa@project.iam.gserviceaccount.com",
    impersonate: "admin@example.com",
    privateKeyPem: privateKey,
    scopes: DWD_SCOPES,
    nowSec: 1_700_000_000,
  });

  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const [headerB64, payloadB64, sigB64] = parts;

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const sig = Buffer.from(sigB64, "base64url");
  assert.ok(verifier.verify(publicKey, sig));
});

test("signSaJwt header and claims match the spec", () => {
  const { privateKey } = makeRsaKeyPair();
  const jwt = signSaJwt({
    saEmail: "sa@project.iam.gserviceaccount.com",
    impersonate: "admin@example.com",
    privateKeyPem: privateKey,
    scopes: DWD_SCOPES,
    nowSec: 1_700_000_000,
  });
  const { header, payload } = decodeJwt(jwt);

  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");

  assert.equal(payload.iss, "sa@project.iam.gserviceaccount.com");
  assert.equal(payload.sub, "admin@example.com");
  assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
  assert.equal(payload.scope, DWD_SCOPES.join(" "));
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_000_000 + 3600);
});

test("signSaJwt segments are base64url (no +/= characters)", () => {
  const { privateKey } = makeRsaKeyPair();
  const jwt = signSaJwt({
    saEmail: "sa@project.iam.gserviceaccount.com",
    impersonate: "admin@example.com",
    privateKeyPem: privateKey,
    scopes: DWD_SCOPES,
  });
  for (const part of jwt.split(".")) {
    assert.match(part, /^[A-Za-z0-9_-]+$/);
  }
});

test("keyPemFromBase64Json decodes a base64 JSON key file into {saEmail, privateKeyPem}", () => {
  const keyFile = {
    type: "service_account",
    project_id: "proj-1",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    client_email: "sa@proj-1.iam.gserviceaccount.com",
  };
  const b64 = Buffer.from(JSON.stringify(keyFile), "utf8").toString("base64");
  const decoded = keyPemFromBase64Json(b64);
  assert.deepEqual(decoded, {
    saEmail: "sa@proj-1.iam.gserviceaccount.com",
    privateKeyPem: keyFile.private_key,
  });
});

test("keyPemFromBase64Json returns null on garbage input", () => {
  assert.equal(keyPemFromBase64Json("not-valid-base64-json!!!"), null);
  assert.equal(keyPemFromBase64Json(Buffer.from("not json at all", "utf8").toString("base64")), null);
  assert.equal(keyPemFromBase64Json(Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64")), null);
});

function validKeyBase64(privateKeyPem: string): string {
  const keyFile = {
    type: "service_account",
    private_key: privateKeyPem,
    client_email: "sa@proj-1.iam.gserviceaccount.com",
  };
  return Buffer.from(JSON.stringify(keyFile), "utf8").toString("base64");
}

test("probeGoogleDirectory happy path returns {ok:true, customerId} from the first user row", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);

  let tokenUrl = "";
  let usersUrl = "";
  let tokenBody = "";
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenUrl = url;
      tokenBody = String(init?.body ?? "");
      return OK({ access_token: "at-123", token_type: "Bearer", expires_in: 3599 });
    }
    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      usersUrl = url;
      return OK({ users: [{ customerId: "C0abc1234" }] });
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const r = await probeGoogleDirectory({ keyBase64, impersonate: "admin@example.com", fetcher: f });

  assert.equal(tokenUrl, "https://oauth2.googleapis.com/token");
  const params = new URLSearchParams(tokenBody);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.ok(params.get("assertion")?.split(".").length === 3);
  assert.match(usersUrl, /customer=my_customer/);
  assert.match(usersUrl, /maxResults=1/);

  assert.deepEqual(r, { ok: true, customerId: "C0abc1234" });
});

test("probeGoogleDirectory returns {ok:true} without customerId when users list is empty", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) return OK({ access_token: "at-123" });
    return OK({ users: [] });
  }) as unknown as typeof fetch;

  const r = await probeGoogleDirectory({ keyBase64, impersonate: "admin@example.com", fetcher: f });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.customerId === undefined);
});

test("probeGoogleDirectory returns {ok:false} on a token exchange failure", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  const f = (async () => ERR({ error: "invalid_grant" }, 400)) as unknown as typeof fetch;
  const r = await probeGoogleDirectory({ keyBase64, impersonate: "admin@example.com", fetcher: f });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.includes("invalid_grant"));
});

test("probeGoogleDirectory returns {ok:false} on a directory API failure", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) return OK({ access_token: "at-123" });
    return ERR({ error: { message: "insufficient permission" } }, 403);
  }) as unknown as typeof fetch;
  const r = await probeGoogleDirectory({ keyBase64, impersonate: "admin@example.com", fetcher: f });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.includes("insufficient permission"));
});

test("probeGoogleDirectory returns {ok:false} on garbage keyBase64 without throwing", async () => {
  const f = (async () => OK({})) as unknown as typeof fetch;
  const r = await probeGoogleDirectory({ keyBase64: "garbage!!!", impersonate: "admin@example.com", fetcher: f });
  assert.equal(r.ok, false);
});

test("probeGoogleDirectory never leaks the private key or a token into the error string", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  const f = (async () => ERR({ error: "unauthorized_client", access_token: "should-never-leak", private_key: privateKey }, 400)) as unknown as typeof fetch;
  const r = await probeGoogleDirectory({ keyBase64, impersonate: "admin@example.com", fetcher: f });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.includes("should-never-leak"));
  assert.ok(!r.ok && !r.error.includes(privateKey));
});

test("probeWithDwdRetry retries on unauthorized_client then succeeds (3 attempts, zero-delay sleep)", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  let tokenCalls = 0;
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls++;
      if (tokenCalls <= 2) return ERR({ error: "unauthorized_client" }, 400);
      return OK({ access_token: "at-123" });
    }
    return OK({ users: [{ customerId: "C0final" }] });
  }) as unknown as typeof fetch;

  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };

  const r = await probeWithDwdRetry({ keyBase64, impersonate: "admin@example.com", fetcher: f }, { sleep });

  assert.equal(tokenCalls, 3);
  assert.equal(r.ok, true);
  assert.equal(r.customerId, "C0final");
  assert.equal(sleeps.length, 2);
});

test("probeWithDwdRetry retries on access_denied and on bare HTTP 403", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  let tokenCalls = 0;
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls++;
      if (tokenCalls === 1) return ERR({ error: "access_denied" }, 400);
      if (tokenCalls === 2) return ERR({}, 403);
      return OK({ access_token: "at-123" });
    }
    return OK({ users: [{ customerId: "C0final" }] });
  }) as unknown as typeof fetch;

  const sleep = async () => {};
  const r = await probeWithDwdRetry({ keyBase64, impersonate: "admin@example.com", fetcher: f }, { sleep });

  assert.equal(tokenCalls, 3);
  assert.equal(r.ok, true);
});

test("probeWithDwdRetry fails fast (1 attempt) on invalid_grant", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  let tokenCalls = 0;
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls++;
      return ERR({ error: "invalid_grant" }, 400);
    }
    return OK({ users: [] });
  }) as unknown as typeof fetch;

  const sleep = async () => { throw new Error("sleep should never be called"); };
  const r = await probeWithDwdRetry({ keyBase64, impersonate: "admin@example.com", fetcher: f }, { sleep });

  assert.equal(tokenCalls, 1);
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("invalid_grant"));
});

test("probeWithDwdRetry gives up after exhausting attempts and reports the last error", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  let tokenCalls = 0;
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls++;
      return ERR({ error: "unauthorized_client" }, 400);
    }
    return OK({ users: [] });
  }) as unknown as typeof fetch;

  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const r = await probeWithDwdRetry({ keyBase64, impersonate: "admin@example.com", fetcher: f }, { attempts: 3, sleep });

  assert.equal(tokenCalls, 3);
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("unauthorized_client"));
  assert.equal(sleeps.length, 2);
});

test("probeWithDwdRetry defaults to 8 attempts x 15000ms delay", async () => {
  const { privateKey } = makeRsaKeyPair();
  const keyBase64 = validKeyBase64(privateKey);
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) return ERR({ error: "unauthorized_client" }, 400);
    return OK({ users: [] });
  }) as unknown as typeof fetch;

  let calls = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { calls++; sleeps.push(ms); };
  const r = await probeWithDwdRetry({ keyBase64, impersonate: "admin@example.com", fetcher: f }, { sleep });

  assert.equal(r.ok, false);
  assert.equal(calls, 7); // 8 attempts, 7 sleeps between them
  assert.ok(sleeps.every((ms) => ms === 15000));
});
