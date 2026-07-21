import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchMimecastConsoleJob, MIMECAST_CONSOLE_SECRET_NAME, MIMECAST_CONSOLE_URL } from "./dispatch-mimecast-console-job";
import { MIMECAST_CONSOLE_SETUP_KEY } from "@/lib/jobs/adhoc";
import { MIMECAST_AUTOSETUP_MARKER } from "@/lib/cases/exclude-m365-autosetup";

function fakeDb() {
  const created: { case?: any; job?: any } = {};
  return {
    created,
    caseRequest: { create: async ({ data }: any) => { created.case = data; return { id: "case-1" }; } },
    job: { create: async ({ data }: any) => { created.job = data; return { id: "job-1" }; } },
  } as any;
}

const client = { id: "client-1" };

test("dispatchMimecastConsoleJob (signInOnly): synthetic marked case + a mimecast-console-setup job", async () => {
  const db = fakeDb();
  const r = await dispatchMimecastConsoleJob({ db, client, signInOnly: true });
  assert.deepEqual(r, { ok: true, jobId: "job-1" });

  // synthetic case: onboard/api, tied to the client, flagged for /cases exclusion. NO secretOverrides
  // — the console login is a persistent client secret resolved by the normal broker.
  assert.equal(db.created.case.action, "onboard");
  assert.equal(db.created.case.createdSource, "api");
  assert.equal(db.created.case.clientId, "client-1");
  assert.equal(db.created.case.payload[MIMECAST_AUTOSETUP_MARKER], true);
  assert.equal(db.created.case.secretOverrides, undefined);

  // job: mimecast-console-setup, api mode, singleRun; config carries the console URL + signInOnly
  assert.equal(db.created.job.caseRequestId, "case-1");
  assert.equal(db.created.job.systemKey, MIMECAST_CONSOLE_SETUP_KEY);
  assert.equal(db.created.job.mode, "api");
  assert.equal(db.created.job.singleRun, true);
  assert.deepEqual(db.created.job.request.config, { consoleUrl: MIMECAST_CONSOLE_URL, signInOnly: true });
  // claim-gate invariant: the ONLY required secret is the console login, so the job is claimable only
  // once it's wired (exactly the precondition the flow needs).
  assert.deepEqual(db.created.job.request.secretNames, [MIMECAST_CONSOLE_SECRET_NAME]);
});

test("dispatchMimecastConsoleJob: a custom console URL overrides the default", async () => {
  const db = fakeDb();
  await dispatchMimecastConsoleJob({ db, client, signInOnly: true, consoleUrl: "https://login-uk.mimecast.com/" });
  assert.equal(db.created.job.request.config.consoleUrl, "https://login-uk.mimecast.com/");
});

test("dispatchMimecastConsoleJob: signInOnly:false is carried through (Phase 2 full run)", async () => {
  const db = fakeDb();
  await dispatchMimecastConsoleJob({ db, client, signInOnly: false });
  assert.equal(db.created.job.request.config.signInOnly, false);
  assert.equal(db.created.case.subject, "Mimecast API automated setup (console)");
});

test("dispatchMimecastConsoleJob: db failure returns ok:false with the error message", async () => {
  const db = { caseRequest: { create: async () => { throw new Error("db down"); } } } as any;
  const r = await dispatchMimecastConsoleJob({ db, client, signInOnly: true });
  assert.deepEqual(r, { ok: false, error: "db down" });
});
