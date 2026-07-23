import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFreshness, BACKUP_STALE_HOURS, DRILL_STALE_DAYS } from "./backup-freshness";
import { normalizeDbBackup } from "./db-backup";
import { normalizeDrill } from "./restore-drill";

const now = new Date("2026-07-22T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3_600_000).toISOString();

const backupSetting = (over: Record<string, unknown> = {}) =>
  normalizeDbBackup({ lastResult: { ok: true, at: hoursAgo(2), ...over } });
const drillSetting = (over: Record<string, unknown> = {}) =>
  normalizeDrill({ lastResult: { ok: true, at: daysAgo(1), ...over } });

test("computeFreshness: all fresh + drill passed + azure off => healthy", () => {
  const f = computeFreshness(backupSetting(), drillSetting(), false, now);
  assert.equal(f.backupOk, true);
  assert.equal(f.backupStale, false);
  assert.equal(f.blobOk, true); // azure dark => off-box not required => true
  assert.equal(f.drillOk, true);
  assert.equal(f.drillStale, false);
  assert.equal(f.healthy, true);
});

test("computeFreshness: a backup older than 26h is stale => not healthy", () => {
  const f = computeFreshness(backupSetting({ at: hoursAgo(BACKUP_STALE_HOURS + 1) }), drillSetting(), false, now);
  assert.equal(f.backupStale, true);
  assert.equal(f.healthy, false);
  assert.ok((f.backupAgeHours ?? 0) > BACKUP_STALE_HOURS);
});

test("computeFreshness: a failed last backup is not ok and not healthy", () => {
  const f = computeFreshness(backupSetting({ ok: false }), drillSetting(), false, now);
  assert.equal(f.backupOk, false);
  assert.equal(f.backupStale, true);
  assert.equal(f.healthy, false);
});

test("computeFreshness: no backup ever recorded => stale, not healthy", () => {
  const f = computeFreshness(normalizeDbBackup(null), drillSetting(), false, now);
  assert.equal(f.lastBackupAt, null);
  assert.equal(f.backupStale, true);
  assert.equal(f.healthy, false);
});

test("computeFreshness: backup fresh but drill stale (>8d) => not healthy", () => {
  const f = computeFreshness(backupSetting(), drillSetting({ at: daysAgo(DRILL_STALE_DAYS + 1) }), false, now);
  assert.equal(f.backupStale, false);
  assert.equal(f.drillStale, true);
  assert.equal(f.healthy, false);
});

test("computeFreshness: backup fresh but LAST DRILL FAILED => not healthy", () => {
  const f = computeFreshness(backupSetting(), drillSetting({ ok: false }), false, now);
  assert.equal(f.drillOk, false);
  assert.equal(f.drillStale, true);
  assert.equal(f.healthy, false);
});

test("computeFreshness: no drill ever => not healthy", () => {
  const f = computeFreshness(backupSetting(), normalizeDrill(null), false, now);
  assert.equal(f.lastDrillAt, null);
  assert.equal(f.drillStale, true);
  assert.equal(f.healthy, false);
});

test("computeFreshness: azure ENABLED but upload failed => blobOk false => not healthy", () => {
  const f = computeFreshness(backupSetting({ uploadError: "az upload failed" }), drillSetting(), true, now);
  assert.equal(f.blobOk, false);
  assert.equal(f.healthy, false);
});

test("computeFreshness: azure ENABLED and a fresh upload present => blobOk true => healthy", () => {
  const f = computeFreshness(backupSetting({ blobUploadedAt: hoursAgo(2) }), drillSetting(), true, now);
  assert.equal(f.blobOk, true);
  assert.equal(f.healthy, true);
});

test("computeFreshness: azure ENABLED but the off-box copy is stale (>26h) => blobOk false", () => {
  const f = computeFreshness(backupSetting({ blobUploadedAt: hoursAgo(BACKUP_STALE_HOURS + 5) }), drillSetting(), true, now);
  assert.equal(f.blobOk, false);
  assert.equal(f.healthy, false);
});

test("computeFreshness: azure ENABLED but no upload recorded => blobOk false", () => {
  const f = computeFreshness(backupSetting(), drillSetting(), true, now); // backupSetting has no blobUploadedAt
  assert.equal(f.blobOk, false);
  assert.equal(f.healthy, false);
});
