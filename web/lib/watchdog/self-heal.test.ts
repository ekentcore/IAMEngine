import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProbe, createSelfHeal, createRestartBudget } from "./self-heal";

// ── classifyProbe: the discriminator that keeps a restart from looping ──────────────────────────
// "broken" = the probe ROUTE never ran (poisoned dev module graph, wedged listener) — a restart
// fixes it. "db-down" = the route ran and reported the database unreachable — a restart would NOT
// fix it and must never be attempted (it would loop forever).

test("a healthy probe is ok", () => {
  assert.equal(classifyProbe(200, { probe: "iam", db: true }), "ok");
});

test("route ran but the DB is unreachable → db-down, never restart-worthy", () => {
  assert.equal(classifyProbe(200, { probe: "iam", db: false }), "db-down");
});

test("a 5xx is broken regardless of body — the route did not answer", () => {
  assert.equal(classifyProbe(500, "<!DOCTYPE html>… ModuleBuildError …"), "broken");
  assert.equal(classifyProbe(500, { error: "internal error" }), "broken");
});

test("a non-5xx WITHOUT the probe marker is broken — something answered that wasn't the route", () => {
  assert.equal(classifyProbe(200, { hello: "world" }), "broken");
  assert.equal(classifyProbe(401, null), "broken");
});

// ── the state machine ───────────────────────────────────────────────────────────────────────────

function harness(over: { supervised?: boolean; budgetOk?: boolean } = {}) {
  const calls = { exited: 0, logs: [] as string[], audits: [] as string[] };
  let result: { status: number; body: unknown } | null = { status: 200, body: { probe: "iam", db: true } };
  const wd = createSelfHeal({
    probe: async () => result,
    supervised: over.supervised ?? true,
    exit: () => { calls.exited++; },
    log: (m) => calls.logs.push(m),
    audit: async (a) => { calls.audits.push(a); },
    restartBudget: { take: () => over.budgetOk ?? true },
    failThreshold: 3,
    graceMs: 60_000,
  });
  return { wd, calls, setResult: (r: typeof result) => { result = r; } };
}

test("3 consecutive broken probes announce, and the exit fires only after the grace period", async () => {
  const { wd, calls, setResult } = harness();
  let now = 0;
  setResult({ status: 500, body: "html" });
  for (let i = 0; i < 3; i++) await wd.tick((now += 20_000));
  assert.equal(wd.state(), "announced");
  assert.equal(calls.exited, 0, "no exit before the grace period");
  assert.ok(calls.logs.some((l) => /restart/i.test(l)));
  await wd.tick((now += 30_000)); // 30s in — still inside grace
  assert.equal(calls.exited, 0);
  await wd.tick((now += 31_000)); // past the 60s grace, still broken
  assert.equal(calls.exited, 1, "supervised + still broken after grace → exit for the supervisor to relaunch");
});

test("recovery during the grace period cancels the restart", async () => {
  const { wd, calls, setResult } = harness();
  let now = 0;
  setResult({ status: 500, body: "x" });
  for (let i = 0; i < 3; i++) await wd.tick((now += 20_000));
  assert.equal(wd.state(), "announced");
  setResult({ status: 200, body: { probe: "iam", db: true } });
  await wd.tick((now += 20_000));
  assert.equal(wd.state(), "healthy");
  await wd.tick((now += 120_000));
  assert.equal(calls.exited, 0, "a recovered server must not be killed");
});

test("unsupervised: log loudly, never exit — an exit with no supervisor takes the site down", async () => {
  const { wd, calls, setResult } = harness({ supervised: false });
  let now = 0;
  setResult({ status: 500, body: "x" });
  for (let i = 0; i < 6; i++) await wd.tick((now += 20_000));
  await wd.tick((now += 120_000));
  assert.equal(calls.exited, 0);
  assert.ok(calls.logs.some((l) => /restart the dev server|supervisor/i.test(l)));
});

test("db-down never triggers the restart path — restarting cannot reach an unreachable database", async () => {
  const { wd, calls, setResult } = harness();
  let now = 0;
  setResult({ status: 200, body: { probe: "iam", db: false } });
  for (let i = 0; i < 10; i++) await wd.tick((now += 20_000));
  assert.equal(wd.state(), "db-down");
  assert.equal(calls.exited, 0);
});

test("an exhausted restart budget blocks the exit — a fault that survives restarts must not loop", async () => {
  const { wd, calls, setResult } = harness({ budgetOk: false });
  let now = 0;
  setResult({ status: 500, body: "x" });
  for (let i = 0; i < 3; i++) await wd.tick((now += 20_000));
  await wd.tick((now += 61_000));
  assert.equal(calls.exited, 0);
  assert.ok(calls.logs.some((l) => /budget|too many/i.test(l)));
});

test("a network error probing our own loopback counts as broken", async () => {
  const { wd, setResult } = harness();
  let now = 0;
  setResult(null);
  for (let i = 0; i < 3; i++) await wd.tick((now += 20_000));
  assert.equal(wd.state(), "announced");
});

// ── restart budget ──────────────────────────────────────────────────────────────────────────────

test("restart budget: 3 per hour, pruned by window", () => {
  let stored = "[]";
  const b = createRestartBudget({
    read: () => stored,
    write: (s) => { stored = s; },
    max: 3,
    windowMs: 60 * 60_000,
    now: () => 1_000_000,
  });
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, "4th within the hour is refused");
  // An hour later the window has rolled — allowed again.
  const later = createRestartBudget({ read: () => stored, write: (s) => { stored = s; }, max: 3, windowMs: 60 * 60_000, now: () => 1_000_000 + 61 * 60_000 });
  assert.equal(later.take(), true);
});
