import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDecision, normalizeUrl } from "./agent-migration";

test("normalizeUrl strips trailing slash, trims, lowercases", () => {
  assert.equal(normalizeUrl(" https://Old.Example.org/ "), "https://old.example.org");
  assert.equal(normalizeUrl(null), "");
});

test("no target set → never migrate", () => {
  const d = migrateDecision({ setting: null, agentMigrateRequested: true, reportedUrl: "https://old" });
  assert.deepEqual(d, { migrate: false, targetUrl: null, converged: false });
});

test("canary flag migrates to target when not yet on it", () => {
  const d = migrateDecision({ setting: { targetUrl: "https://new" }, agentMigrateRequested: true, reportedUrl: "https://old" });
  assert.equal(d.migrate, true);
  assert.equal(d.targetUrl, "https://new");
  assert.equal(d.converged, false);
});

test("fleet-enabled migrates every agent not yet on target", () => {
  const d = migrateDecision({ setting: { enabled: true, targetUrl: "https://new" }, agentMigrateRequested: false, reportedUrl: "https://old" });
  assert.equal(d.migrate, true);
});

test("target set but neither canary nor enabled → wait, do not migrate", () => {
  const d = migrateDecision({ setting: { enabled: false, targetUrl: "https://new" }, agentMigrateRequested: false, reportedUrl: "https://old" });
  assert.equal(d.migrate, false);
  assert.equal(d.converged, false);
});

test("already on target (normalized) → converged, never migrate", () => {
  const d = migrateDecision({ setting: { enabled: true, targetUrl: "https://New/" }, agentMigrateRequested: true, reportedUrl: "https://new" });
  assert.equal(d.migrate, false);
  assert.equal(d.converged, true);
  assert.equal(d.targetUrl, "https://New/");
});
