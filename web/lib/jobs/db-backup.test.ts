import { test } from "node:test";
import assert from "node:assert/strict";
import { backupDue, dbBackupStatus, normalizeDbBackup } from "./db-backup";

// backupDue anchors to the LOCAL hourLocal boundary, so tests build local dates
// (new Date(y, m, d, h)) — an ISO Z string would shift with the runner's timezone.
const local = (d: number, h: number, min = 0) => new Date(2026, 6, d, h, min);

test("normalizeDbBackup: default-on with sane defaults", () => {
  const s = normalizeDbBackup(null);
  assert.equal(s.enabled, true); // a missing setting must not mean "no backups"
  assert.equal(s.hourLocal, 2);
  assert.equal(s.keepDays, 30);
  assert.equal(normalizeDbBackup({ enabled: false }).enabled, false);
  assert.equal(normalizeDbBackup({ hourLocal: 99 }).hourLocal, 2); // out of range -> default
  assert.equal(normalizeDbBackup({ keepDays: 0 }).keepDays, 30);
});

test("backupDue: disabled never fires; never-run fires immediately", () => {
  assert.equal(backupDue(normalizeDbBackup({ enabled: false }), local(13, 3)), false);
  assert.equal(backupDue(normalizeDbBackup(null), local(13, 3)), true);
  assert.equal(backupDue(normalizeDbBackup(null), local(13, 1)), true); // even before the hour
});

test("backupDue: one run per night, anchored to the 02:00 local boundary", () => {
  // ran last night at 02:00:30; it is now 01:00 the next day -> boundary is
  // yesterday 02:00, already covered -> not due
  const ranLastNight = normalizeDbBackup({ lastStartedAt: local(12, 2, 1).toISOString() });
  assert.equal(backupDue(ranLastNight, local(13, 1)), false);
  // now 02:00 the next day -> new boundary -> due
  assert.equal(backupDue(ranLastNight, local(13, 2)), true);
  // ran tonight at 02:05; later the same day -> not due again
  const ranTonight = normalizeDbBackup({ lastStartedAt: local(13, 2, 5).toISOString() });
  assert.equal(backupDue(ranTonight, local(13, 23)), false);
  // a run that happened BEFORE tonight's boundary (e.g. manual at 01:00) does not
  // satisfy the 02:00 boundary once it passes
  const ranEarly = normalizeDbBackup({ lastStartedAt: local(13, 1).toISOString() });
  assert.equal(backupDue(ranEarly, local(13, 2, 30)), true);
});

test("backupDue: an unparseable lastStartedAt reads as due, not as never-again", () => {
  const s = normalizeDbBackup({ lastStartedAt: "not-a-date" });
  assert.equal(backupDue(s, local(13, 3)), true);
});

test("dbBackupStatus: one projection with defaults filled", () => {
  const st = dbBackupStatus(null);
  assert.equal(st.enabled, true);
  assert.equal(st.hourLocal, 2);
  assert.equal(st.keepDays, 30);
  assert.ok(st.backupDir.endsWith("Backups/iam-engine"));
  assert.equal(st.lastStartedAt, null);
  assert.equal(st.lastResult, null);
});

test("backupDue: honors a custom hourLocal", () => {
  const s = normalizeDbBackup({ hourLocal: 22, lastStartedAt: local(12, 22, 1).toISOString() });
  assert.equal(backupDue(s, local(13, 21)), false);
  assert.equal(backupDue(s, local(13, 22)), true);
});
