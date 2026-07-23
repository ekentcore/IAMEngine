import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyConnectFailure, probeConnection, type ProbeDeps } from "./probe";
import type { PgConn } from "./config";

const CONN: PgConn = {
  host: "db-azure.postgres.database.azure.com",
  port: 5432,
  user: "iam_migrator",
  password: "sup3r-s3cret-p@ss",
  database: "automationUM",
  schema: "public",
};

// --- classifyConnectFailure: the pure attribution logic --------------------------------------

test("classifyConnectFailure blames the database step when the catalog is missing (3D000)", () => {
  assert.equal(classifyConnectFailure("3D000", 'database "automationUM" does not exist'), "database");
});

test("classifyConnectFailure blames authentication for a bad password (28P01)", () => {
  assert.equal(classifyConnectFailure("28P01", 'password authentication failed for user "iam_migrator"'), "authenticated");
});

test("classifyConnectFailure blames authentication for invalid authorization (28000)", () => {
  assert.equal(classifyConnectFailure("28000", "no pg_hba.conf entry"), "authenticated");
});

test("classifyConnectFailure blames reachability for DNS + socket errnos", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"]) {
    assert.equal(classifyConnectFailure(code, "getaddrinfo failed"), "reachable", `expected ${code} -> reachable`);
  }
});

test("classifyConnectFailure defaults an unknown connect error to authentication", () => {
  assert.equal(classifyConnectFailure(undefined, "something weird"), "authenticated");
});

// --- probeConnection: orchestration via injected fakes ---------------------------------------

function fakeDeps(over: Partial<ProbeDeps>): ProbeDeps {
  return {
    tcpCheck: async () => 12,
    connect: async () => ({
      query: async (sql: string) => {
        if (/version\(\)/.test(sql)) return { rows: [{ version: "PostgreSQL 16.2 on x86_64" }] };
        return { rows: [{ n: "37" }] };
      },
      end: async () => {},
    }),
    ...over,
  };
}

test("probeConnection: all steps succeed and report details", async () => {
  const res = await probeConnection(CONN, fakeDeps({}));
  assert.equal(res.ok, true);
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.config.status, "ok");
  assert.equal(byStep.reachable.status, "ok");
  assert.equal(byStep.authenticated.status, "ok");
  assert.equal(byStep.database.status, "ok");
  assert.equal(byStep.version.status, "ok");
  assert.equal(byStep.tables.status, "ok");
  assert.match(byStep.version.detail ?? "", /16\.2/);
  assert.match(byStep.tables.detail ?? "", /37/);
});

test("probeConnection: TCP unreachable fails 'reachable' and skips the rest", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const res = await probeConnection(CONN, fakeDeps({ tcpCheck: async () => { throw err; } }));
  assert.equal(res.ok, false);
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.config.status, "ok");
  assert.equal(byStep.reachable.status, "fail");
  assert.equal(byStep.authenticated.status, "skipped");
  assert.equal(byStep.database.status, "skipped");
  assert.equal(byStep.version.status, "skipped");
  assert.equal(byStep.tables.status, "skipped");
});

test("probeConnection: bad password fails 'authenticated' (reachable already passed)", async () => {
  const err = Object.assign(new Error("password authentication failed for user"), { code: "28P01" });
  const res = await probeConnection(CONN, fakeDeps({ connect: async () => { throw err; } }));
  assert.equal(res.ok, false);
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.reachable.status, "ok");
  assert.equal(byStep.authenticated.status, "fail");
  assert.equal(byStep.database.status, "skipped");
});

test("probeConnection: missing catalog fails 'database'", async () => {
  const err = Object.assign(new Error('database "automationUM" does not exist'), { code: "3D000" });
  const res = await probeConnection(CONN, fakeDeps({ connect: async () => { throw err; } }));
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.authenticated.status, "ok");
  assert.equal(byStep.database.status, "fail");
});

test("probeConnection: the password never appears anywhere in the result", async () => {
  const err = Object.assign(new Error(`connection to ${CONN.password}@host failed`), { code: "28P01" });
  const okRes = await probeConnection(CONN, fakeDeps({}));
  const failRes = await probeConnection(CONN, fakeDeps({ connect: async () => { throw err; } }));
  assert.doesNotMatch(JSON.stringify(okRes), new RegExp(CONN.password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(failRes), new RegExp(CONN.password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
