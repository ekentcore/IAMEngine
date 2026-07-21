import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchGoogleOAuthJob, dispatchGoogleDwdJob } from "./dispatch-google-browser-job";
import { GOOGLE_OAUTH_SIGNIN_KEY, GOOGLE_DWD_GRANT_KEY } from "@/lib/jobs/adhoc";
import { GOOGLE_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

function fakeDb() {
  const created: { case?: any; job?: any } = {};
  return {
    created,
    caseRequest: { create: async ({ data }: any) => { created.case = data; return { id: "case-1" }; } },
    job: { create: async ({ data }: any) => { created.job = data; return { id: "job-1" }; } },
  } as any;
}

const client = { id: "client-1", slug: "acme", name: "Acme" };

test("dispatchGoogleOAuthJob: creates a synthetic onboard case then a google-oauth-signin job", async () => {
  const db = fakeDb();
  const r = await dispatchGoogleOAuthJob({
    db,
    client,
    seedSecretRef: "delinea-ext-google-1",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth?foo=bar",
    redirectUri: "http://127.0.0.1:8765/oauth2callback",
  });
  assert.deepEqual(r, { ok: true, jobId: "job-1" });

  // synthetic case: onboard, api source, tied to the client, marked for /cases queue exclusion
  assert.equal(db.created.case.action, "onboard");
  assert.equal(db.created.case.createdSource, "api");
  assert.equal(db.created.case.clientId, "client-1");
  assert.equal(db.created.case.payload[GOOGLE_AUTOSETUP_MARKER], true);
  assert.deepEqual(db.created.case.secretOverrides, { "google-super-admin": "delinea-ext-google-1" });

  // job: google-oauth-signin, api mode, singleRun, non-secret config payload
  assert.equal(db.created.job.caseRequestId, "case-1");
  assert.equal(db.created.job.systemKey, GOOGLE_OAUTH_SIGNIN_KEY);
  assert.equal(db.created.job.mode, "api");
  assert.equal(db.created.job.singleRun, true);
  assert.deepEqual(db.created.job.request.config, {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth?foo=bar",
    redirectUri: "http://127.0.0.1:8765/oauth2callback",
  });
  // claim-gate invariant: the ONLY secretNames entry is the one secretOverrides supplies
  assert.deepEqual(db.created.job.request.secretNames, ["google-super-admin"]);
});

test("dispatchGoogleOAuthJob: db failure returns ok:false with the error message", async () => {
  const db = {
    caseRequest: { create: async () => { throw new Error("db down"); } },
  } as any;
  const r = await dispatchGoogleOAuthJob({
    db,
    client,
    seedSecretRef: "ref",
    authUrl: "https://accounts.google.com/x",
    redirectUri: "http://127.0.0.1:8765/oauth2callback",
  });
  assert.deepEqual(r, { ok: false, error: "db down" });
});

test("dispatchGoogleDwdJob: creates a synthetic onboard case then a google-dwd-grant job", async () => {
  const db = fakeDb();
  const r = await dispatchGoogleDwdJob({
    db,
    client,
    seedSecretRef: "delinea-ext-google-2",
    saClientId: "123456789012345678901",
    scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
  });
  assert.deepEqual(r, { ok: true, jobId: "job-1" });

  assert.equal(db.created.case.action, "onboard");
  assert.equal(db.created.case.createdSource, "api");
  assert.equal(db.created.case.clientId, "client-1");
  assert.equal(db.created.case.payload[GOOGLE_AUTOSETUP_MARKER], true);
  assert.deepEqual(db.created.case.secretOverrides, { "google-super-admin": "delinea-ext-google-2" });

  assert.equal(db.created.job.caseRequestId, "case-1");
  assert.equal(db.created.job.systemKey, GOOGLE_DWD_GRANT_KEY);
  assert.equal(db.created.job.mode, "api");
  assert.equal(db.created.job.singleRun, true);
  assert.deepEqual(db.created.job.request.config, {
    saClientId: "123456789012345678901",
    scopes: ["https://www.googleapis.com/auth/admin.directory.user"],
  });
  assert.deepEqual(db.created.job.request.secretNames, ["google-super-admin"]);
});

test("dispatchGoogleDwdJob: db failure returns ok:false with the error message", async () => {
  const db = {
    caseRequest: { create: async () => { throw new Error("db down"); } },
  } as any;
  const r = await dispatchGoogleDwdJob({
    db,
    client,
    seedSecretRef: "ref",
    saClientId: "sa-1",
    scopes: ["scope-a"],
  });
  assert.deepEqual(r, { ok: false, error: "db down" });
});
