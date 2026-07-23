import { test } from "node:test";
import assert from "node:assert/strict";
import { worstVerdict, rollupClient, overallVerdict } from "./rollup";
import type { CheckResult, Verdict } from "./checks";

function chk(id: string, verdict: Verdict, blocking = false): CheckResult {
  return { id, verdict, headline: id, detail: "", liveness: "live", blocking };
}

test("worstVerdict: fail > warn > pass; na ignored; all-na → na", () => {
  assert.equal(worstVerdict([chk("a", "pass"), chk("b", "warn"), chk("c", "fail")]), "fail");
  assert.equal(worstVerdict([chk("a", "pass"), chk("b", "warn")]), "warn");
  assert.equal(worstVerdict([chk("a", "pass"), chk("b", "na")]), "pass");
  assert.equal(worstVerdict([chk("a", "na"), chk("b", "na")]), "na");
  assert.equal(worstVerdict([]), "na");
});

test("rollupClient: carries the checks and the worst verdict", () => {
  const r = rollupClient("acme", "Acme", [chk("x", "pass"), chk("y", "fail")]);
  assert.equal(r.slug, "acme");
  assert.equal(r.verdict, "fail");
  assert.equal(r.checks.length, 2);
});

test("overallVerdict: any blocking fail → NO_GO", () => {
  const o = overallVerdict([chk("db", "fail", true)], []);
  assert.equal(o.verdict, "NO_GO");
  assert.equal(o.blockingFailures, 1);
});

test("overallVerdict: a NON-blocking fail degrades to GO_WITH_WARNINGS, not NO_GO", () => {
  const o = overallVerdict([chk("servicenow", "fail", false)], []);
  assert.equal(o.verdict, "GO_WITH_WARNINGS");
  assert.equal(o.blockingFailures, 0);
  assert.equal(o.nonBlockingFailures, 1);
});

test("overallVerdict: a warn (no fail) → GO_WITH_WARNINGS", () => {
  const o = overallVerdict([chk("backups", "warn", false)], []);
  assert.equal(o.verdict, "GO_WITH_WARNINGS");
  assert.equal(o.warnings, 1);
});

test("overallVerdict: everything pass/na → GO", () => {
  const o = overallVerdict([chk("db", "pass", true), chk("azure", "na", false)], [rollupClient("a", "A", [chk("m365", "na")])]);
  assert.equal(o.verdict, "GO");
});

test("overallVerdict: a blocking per-client fail flips overall to NO_GO and counts clientsNotReady", () => {
  const clients = [
    rollupClient("a", "A", [chk("client-agent-reachable", "fail", true)]),
    rollupClient("b", "B", [chk("client-creds-ready", "warn", false)]),
  ];
  const o = overallVerdict([chk("db", "pass", true)], clients);
  assert.equal(o.verdict, "NO_GO");
  assert.equal(o.blockingFailures, 1);
  assert.equal(o.clientsNotReady, 1); // only A's rollup is fail; B is warn
});

test("overallVerdict: a non-blocking per-client fail marks the client not-ready but keeps overall GO_WITH_WARNINGS", () => {
  const clients = [rollupClient("a", "A", [chk("client-creds-ready", "fail", false)])];
  const o = overallVerdict([chk("db", "pass", true)], clients);
  assert.equal(o.verdict, "GO_WITH_WARNINGS");
  assert.equal(o.clientsNotReady, 1);
});
