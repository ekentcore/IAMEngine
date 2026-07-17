import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateStatus, type MigrateStatusAgent } from "./migrate-status";
import { nextMigrationSetting } from "@/lib/jobs/agent-migration";

const NOW = Date.parse("2026-07-17T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const base: MigrateStatusAgent = {
  migrateRequested: false,
  migrateRequestedBy: null,
  migrateDeliveredAt: null,
  migratedAt: null,
  migrateError: null,
  lastSeenAt: null,
  currentAppUrl: "http://10.0.0.5:3000",
};
const TARGET = "https://iam.core.tech";

test("nothing in flight → null", () => {
  assert.equal(migrateStatus(base, TARGET, NOW), null);
});

test("error wins over everything else", () => {
  const s = migrateStatus(
    { ...base, migrateError: "verify failed", migratedAt: iso(0), migrateRequested: true, migrateDeliveredAt: iso(0) },
    TARGET,
    NOW
  );
  assert.equal(s?.kind, "failed");
  assert.match(s!.label, /verify failed/);
});

test("migrated shows the reported URL and the requester", () => {
  const s = migrateStatus({ ...base, migratedAt: iso(1000), currentAppUrl: TARGET, migrateRequestedBy: "evan" }, TARGET, NOW);
  assert.equal(s?.kind, "migrated");
  assert.match(s!.label, /by evan/);
  assert.match(s!.label, /iam\.core\.tech/);
});

test("queued while the runner hasn't polled", () => {
  const s = migrateStatus({ ...base, migrateRequested: true }, TARGET, NOW);
  assert.equal(s?.kind, "queued");
});

test("delivered + silent < 5 min → moving (info)", () => {
  const s = migrateStatus({ ...base, migrateDeliveredAt: iso(2 * 60_000) }, TARGET, NOW);
  assert.equal(s?.kind, "moving");
});

test("delivered + silent ≥ 5 min → moving-quiet with minutes, indefinitely", () => {
  const s = migrateStatus({ ...base, migrateDeliveredAt: iso(7 * 60_000) }, TARGET, NOW);
  assert.equal(s?.kind, "moving-quiet");
  assert.match(s!.label, /not communicating on the new URL yet \(7m\)/);
  // Still shown days later — silence never times out.
  const late = migrateStatus({ ...base, migrateDeliveredAt: iso(48 * 60 * 60_000) }, TARGET, NOW);
  assert.equal(late?.kind, "moving-quiet");
});

test("stale lastSeen from BEFORE delivery still counts as silent", () => {
  const s = migrateStatus({ ...base, migrateDeliveredAt: iso(10 * 60_000), lastSeenAt: iso(20 * 60_000) }, TARGET, NOW);
  assert.equal(s?.kind, "moving-quiet");
});

test("reported in after delivery still on the old URL → returned-old", () => {
  const s = migrateStatus(
    { ...base, migrateDeliveredAt: iso(10 * 60_000), lastSeenAt: iso(60_000), currentAppUrl: "http://10.0.0.5:3000" },
    TARGET,
    NOW
  );
  assert.equal(s?.kind, "returned-old");
  assert.match(s!.label, /didn't stick/);
});

test("returned-old goes quiet an hour after delivery (stale history, not a live event)", () => {
  const s = migrateStatus(
    { ...base, migrateDeliveredAt: iso(2 * 60 * 60_000), lastSeenAt: iso(60_000) },
    TARGET,
    NOW
  );
  assert.equal(s, null);
});

test("trailing slash / case in URLs doesn't fake a returned-old", () => {
  const s = migrateStatus(
    { ...base, migrateDeliveredAt: iso(10 * 60_000), lastSeenAt: iso(60_000), currentAppUrl: "HTTPS://iam.core.tech/" },
    TARGET,
    NOW
  );
  assert.equal(s, null); // on-target report; migratedAt (set by the same heartbeat) renders the ✓ instead
});

test("no target configured → a post-delivery report shows nothing rather than guessing", () => {
  const s = migrateStatus({ ...base, migrateDeliveredAt: iso(10 * 60_000), lastSeenAt: iso(60_000) }, null, NOW);
  assert.equal(s, null);
});

test("nextMigrationSetting keeps the proof pointer only while the target is unchanged", () => {
  const existing = { enabled: false, targetUrl: "https://iam.core.tech", proofAgentId: "agent-1" };
  const same = nextMigrationSetting(existing, { enabled: true, targetUrl: "https://IAM.core.tech/" });
  assert.equal(same.proofAgentId, "agent-1");
  assert.equal(same.enabled, true);
  const changed = nextMigrationSetting(existing, { enabled: false, targetUrl: "https://other.core.tech" });
  assert.equal(changed.proofAgentId, null);
  const fresh = nextMigrationSetting(null, { enabled: false, targetUrl: "https://iam.core.tech" });
  assert.equal(fresh.proofAgentId, null);
});
