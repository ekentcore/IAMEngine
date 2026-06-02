import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateJob } from "./sim-executor";
import { hasExecutor, validationChecks } from "../automation";
import type { RunnerJob } from "./types";

function job(over: Partial<RunnerJob>): RunnerJob {
  return {
    id: "j1", action: "onboard", systemKey: "m365", mode: "api",
    client: { slug: "acme", primaryDomain: "acme.com", backbone: "entra" },
    config: null, secretNames: [], payload: {},
    requiresApproval: false, captureEvidence: false, dryRun: false,
    ...over,
  } as RunnerJob;
}

test("a supported system succeeds with a passing validation read-back", () => {
  const res = simulateJob(job({ systemKey: "m365", action: "onboard" }));
  assert.equal(res.status, "succeeded");
  const v = res.validation as { ok: boolean; checks: { name: string; pass: boolean }[] };
  assert.equal(v.ok, true);
  assert.equal(v.checks.length, validationChecks("m365", "onboard").length);
  assert.ok(v.checks.every((c) => c.pass));
  assert.ok((res.result as { Actions: string[] }).Actions.length > 0);
});

test("a system with no executor is skipped, not failed", () => {
  const res = simulateJob(job({ systemKey: "servicenow" }));
  assert.equal(res.status, "skipped");
  assert.match(String(res.error), /no executor for servicenow/);
});

test("onboard and offboard resolve different check sets", () => {
  const on = simulateJob(job({ systemKey: "m365", action: "onboard" })).validation as { checks: { name: string }[] };
  const off = simulateJob(job({ systemKey: "m365", action: "offboard" })).validation as { checks: { name: string }[] };
  assert.ok(on.checks.some((c) => c.name === "AccountEnabled = true"));
  assert.ok(off.checks.some((c) => c.name === "AccountEnabled = false"));
});

test("a supported system with no modeled checks still records a simulated action", () => {
  // exchange onboard has an empty validation set in the registry.
  const res = simulateJob(job({ systemKey: "exchange", action: "onboard" }));
  assert.equal(res.status, "succeeded");
  assert.deepEqual((res.result as { Actions: string[] }).Actions, ["simulated onboard"]);
});

test("dry-run annotates the result and still succeeds", () => {
  const res = simulateJob(job({ systemKey: "m365", dryRun: true }));
  assert.equal(res.status, "succeeded");
  assert.equal((res.result as { dryRun?: boolean }).dryRun, true);
});

test("entra and google-workspace now have executors (no longer skipped)", () => {
  assert.ok(hasExecutor("entra"));            // aliased to the M365 executor
  assert.ok(hasExecutor("google-workspace")); // new module
  assert.equal(simulateJob(job({ systemKey: "entra", action: "onboard" })).status, "succeeded");
  assert.equal(simulateJob(job({ systemKey: "google-workspace", action: "offboard" })).status, "succeeded");
});
