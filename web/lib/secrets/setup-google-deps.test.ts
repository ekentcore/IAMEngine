import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { buildGoogleSetupDeps } from "./setup-google-deps";

// A minimal PrismaClient-shaped fake carrying only the methods the deps touch.
type JobRow = { status: string; result: unknown } | null;
function fakeDb(opts: {
  jobRows?: JobRow[]; // consumed one per findUnique call; last one repeats
  clientSystemCount?: number;
  secretExternalId?: string | null;
}): PrismaClient {
  let idx = 0;
  const rows = opts.jobRows ?? [];
  return {
    job: {
      findUnique: async () => {
        const row = rows[Math.min(idx, rows.length - 1)] ?? null;
        idx++;
        return row;
      },
    },
    clientSystem: {
      count: async () => opts.clientSystemCount ?? 0,
    },
    secret: {
      findUnique: async () => (opts.secretExternalId === undefined ? null : { externalId: opts.secretExternalId }),
    },
  } as unknown as PrismaClient;
}

// A fake clock: sleep advances it, so awaitJobResult's timeout is testable without real waits.
function fakeClock(startMs = 0) {
  let clock = startMs;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

test("buildGoogleSetupDeps exposes the full GoogleSetupDeps surface", () => {
  const deps = buildGoogleSetupDeps(fakeDb({}));
  for (const key of [
    "hasGoogleSystem",
    "readSeedUsername",
    "vaultedKeyPresent",
    "makePkce",
    "buildAuthUrl",
    "dispatchOAuthJob",
    "awaitJobResult",
    "exchangeCode",
    "provision",
    "dispatchDwdJob",
    "probeWithRetry",
    "write",
    "deleteIssuedKey",
  ] as const) {
    assert.equal(typeof deps[key], "function", `missing dep: ${key}`);
  }
});

test("makePkce / buildAuthUrl delegate to the real google-oauth module", () => {
  const deps = buildGoogleSetupDeps(fakeDb({}));
  const pkce = deps.makePkce();
  assert.ok(pkce.verifier && pkce.challenge && pkce.verifier !== pkce.challenge);
  const url = deps.buildAuthUrl(pkce.challenge, "admin@x.org");
  assert.match(url, /accounts\.google\.com/);
  assert.match(url, /code_challenge=/);
  assert.match(url, /login_hint=admin%40x\.org/);
});

test("hasGoogleSystem is true only when a google-workspace ClientSystem row exists", async () => {
  assert.equal(await buildGoogleSetupDeps(fakeDb({ clientSystemCount: 1 })).hasGoogleSystem("c1"), true);
  assert.equal(await buildGoogleSetupDeps(fakeDb({ clientSystemCount: 0 })).hasGoogleSystem("c1"), false);
});

test("vaultedKeyPresent reflects secretIsSet on the google-admin slot", async () => {
  assert.equal(await buildGoogleSetupDeps(fakeDb({ secretExternalId: "12345" })).vaultedKeyPresent("c1"), true);
  assert.equal(await buildGoogleSetupDeps(fakeDb({ secretExternalId: undefined })).vaultedKeyPresent("c1"), false);
  // A REPLACE_ME/blank placeholder is NOT a real vaulted id.
  assert.equal(await buildGoogleSetupDeps(fakeDb({ secretExternalId: "" })).vaultedKeyPresent("c1"), false);
});

test("readSeedUsername returns null when Delinea is unconfigured (unreadable seed)", async () => {
  // No DELINEA_* env in the test process -> resolveSecretFields fails closed -> null.
  const prev = { ...process.env };
  delete process.env.DELINEA_BASE_URL;
  delete process.env.DELINEA_USER;
  delete process.env.DELINEA_PASSWORD;
  try {
    const out = await buildGoogleSetupDeps(fakeDb({})).readSeedUsername("some-ref");
    assert.equal(out, null);
  } finally {
    Object.assign(process.env, prev);
  }
});

test("awaitJobResult: a terminal succeeded job -> ok:true, resultText carries the OAUTH_CODE, warnings extracted", async () => {
  const clock = fakeClock();
  const deps = buildGoogleSetupDeps(
    fakeDb({
      jobRows: [
        { status: "running", result: null },
        {
          status: "succeeded",
          result: { log: "signed in\nOAUTH_CODE:abc123", warn: "WARN consent screen was slow" },
        },
      ],
    }),
    { now: clock.now, sleep: clock.sleep, pollIntervalMs: 1000 }
  );
  const out = await deps.awaitJobResult("job-1", 60_000);
  assert.equal(out.ok, true);
  assert.match(out.resultText ?? "", /OAUTH_CODE:abc123/);
  assert.deepEqual(out.warnings, ["WARN consent screen was slow"]);
});

test("awaitJobResult: a terminal failed job -> ok:false, warnings still extracted", async () => {
  const clock = fakeClock();
  const deps = buildGoogleSetupDeps(
    fakeDb({ jobRows: [{ status: "failed", result: { actions: ["WARN could not add API client"] } }] }),
    { now: clock.now, sleep: clock.sleep, pollIntervalMs: 1000 }
  );
  const out = await deps.awaitJobResult("job-1", 60_000);
  assert.equal(out.ok, false);
  assert.deepEqual(out.warnings, ["WARN could not add API client"]);
});

test("awaitJobResult: a job that never terminates times out -> ok:false", async () => {
  const clock = fakeClock();
  const deps = buildGoogleSetupDeps(
    fakeDb({ jobRows: [{ status: "running", result: null }] }),
    { now: clock.now, sleep: clock.sleep, pollIntervalMs: 1000 }
  );
  const out = await deps.awaitJobResult("job-1", 3000);
  assert.equal(out.ok, false);
  assert.equal(out.resultText, undefined);
});

test("awaitJobResult exits within one poll interval when the cancel signal aborts", async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  let polls = 0;
  const db = {
    job: {
      findUnique: async () => {
        polls++;
        return { status: "running", result: null };
      },
    },
  } as any;
  const deps = buildGoogleSetupDeps(db, {
    now: clock.now,
    sleep: async (ms: number) => {
      await clock.sleep(ms);
      controller.abort(); // the cancel lands while the await sleeps
    },
    pollIntervalMs: 5000,
  });
  const r = await deps.awaitJobResult("job-1", 10 * 60 * 1000, controller.signal);
  assert.equal(r.ok, false);
  assert.equal(polls, 1, "exactly one poll before the abort, none after");
});
