import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDrill, drillDue, evaluateIntegrity, runRestoreDrill, computeStalenessAlert,
  pgUrlsFromEnv, scratchDbName, KEY_TABLES, restoreDrillStatus,
  type IntegritySnapshot, type DrillDeps,
} from "./restore-drill";

// Local dates (new Date(y,m,d,h)) — drillDue anchors to LOCAL wall-clock hours like backupDue.
const local = (d: number, h: number, min = 0) => new Date(2026, 6, d, h, min); // month 6 = July

// A fully-healthy snapshot the negative tests then break one field at a time.
const good = (): IntegritySnapshot => ({
  tables: [...KEY_TABLES, "SystemCatalog", "Agent"],
  rowCounts: Object.fromEntries(KEY_TABLES.map((t) => [t, 5])),
  canaryClientsWithSystem: 4,
  orphanClientSystems: 0,
});
const liveSnap = (): IntegritySnapshot => ({ ...good(), rowCounts: Object.fromEntries(KEY_TABLES.map((t) => [t, 9])) });

test("normalizeDrill: default-on, weekly Sunday 03:00, sane bounds", () => {
  const s = normalizeDrill(null);
  assert.equal(s.enabled, true); // a drill you must remember to enable won't run
  assert.equal(s.dayOfWeek, 0);
  assert.equal(s.hourLocal, 3);
  assert.equal(normalizeDrill({ enabled: false }).enabled, false);
  assert.equal(normalizeDrill({ dayOfWeek: 9 }).dayOfWeek, 0); // out of range -> default
  assert.equal(normalizeDrill({ hourLocal: 99 }).hourLocal, 3);
});

test("drillDue: disabled never fires; never-run fires; unparseable stamp is due", () => {
  assert.equal(drillDue(normalizeDrill({ enabled: false }), local(19, 4)), false);
  assert.equal(drillDue(normalizeDrill(null), local(19, 4)), true); // July 19 2026 is a Sunday
  assert.equal(drillDue(normalizeDrill({ lastStartedAt: "not-a-date" }), local(19, 4)), true);
});

test("drillDue: one run per weekly boundary (Sunday 03:00)", () => {
  // ran this past Sunday (July 19) at 03:05; still the same week -> not due again
  const ranThisWeek = normalizeDrill({ lastStartedAt: local(19, 3, 5).toISOString() });
  assert.equal(drillDue(ranThisWeek, local(22, 12)), false); // Wed
  // ...until the NEXT Sunday boundary passes (July 26 03:00)
  assert.equal(drillDue(ranThisWeek, local(26, 3, 1)), true);
  // before the hour on the boundary day -> the boundary is LAST week, and last run covered it -> not due
  assert.equal(drillDue(ranThisWeek, local(26, 2)), false);
});

test("evaluateIntegrity: a healthy restore passes", () => {
  const v = evaluateIntegrity(good(), liveSnap());
  assert.equal(v.ok, true);
  assert.deepEqual(v.failures, []);
});

test("evaluateIntegrity: an EMPTY key table fails loudly (silent-bad-backup)", () => {
  const s = good();
  s.rowCounts.AuditLog = 0;
  const v = evaluateIntegrity(s, liveSnap());
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /AuditLog restored empty/.test(f)));
});

test("evaluateIntegrity: schema drift (missing live table) fails", () => {
  const s = good();
  s.tables = s.tables.filter((t) => t !== "Secret"); // dropped a table the live DB has
  s.rowCounts.Secret = 0;
  const v = evaluateIntegrity(s, liveSnap());
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /missing .* table/.test(f)));
});

test("evaluateIntegrity: broken FK (orphan ClientSystem) and dead canary fail", () => {
  const s = good();
  s.orphanClientSystems = 3;
  s.canaryClientsWithSystem = 0;
  const v = evaluateIntegrity(s, liveSnap());
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /orphaned ClientSystem/.test(f)));
  assert.ok(v.failures.some((f) => /canary join/.test(f)));
});

// --- orchestration via injected deps ---------------------------------------------------------------
function fakeDeps(over: Partial<DrillDeps> & { scratch?: IntegritySnapshot; restoreThrows?: Error }): {
  deps: DrillDeps; dropped: string[]; created: string[];
} {
  const dropped: string[] = [];
  const created: string[] = [];
  const deps: DrillDeps = {
    liveDbName: "iam",
    scratchName: "iam_drill_x",
    acquireDump: async () => ({ path: "/tmp/latest.dump", source: "local", checksumOk: true }),
    createScratch: async (n) => { created.push(n); },
    restore: async () => { if (over.restoreThrows) throw over.restoreThrows; },
    gatherScratch: async () => over.scratch ?? good(),
    gatherLive: async () => liveSnap(),
    dropScratch: async (n) => { dropped.push(n); },
    ...over,
  };
  return { deps, dropped, created };
}

test("runRestoreDrill: happy path passes and ALWAYS drops the scratch DB", async () => {
  const { deps, dropped } = fakeDeps({});
  const r = await runRestoreDrill(deps);
  assert.equal(r.ok, true);
  assert.equal(r.scratchDb, "iam_drill_x");
  assert.equal(r.source, "local");
  assert.deepEqual(dropped, ["iam_drill_x"]); // teardown happened
});

// THE most important test: a bad/corrupt dump must FAIL the drill loudly (and still tear down).
test("runRestoreDrill: a CORRUPT dump (pg_restore errors) fails the drill and still drops the scratch DB", async () => {
  const { deps, dropped } = fakeDeps({ restoreThrows: new Error("pg_restore: error: could not read from input file: end of file") });
  const r = await runRestoreDrill(deps);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /could not read from input file/);
  assert.deepEqual(dropped, ["iam_drill_x"]); // finally-drop even on failure
});

test("runRestoreDrill: a dump that restores EMPTY fails the drill (still drops)", async () => {
  const empty = good();
  for (const t of KEY_TABLES) empty.rowCounts[t] = 0;
  empty.canaryClientsWithSystem = 0;
  const { deps, dropped } = fakeDeps({ scratch: empty });
  const r = await runRestoreDrill(deps);
  assert.equal(r.ok, false);
  assert.ok((r.failures ?? []).length > 0);
  assert.deepEqual(dropped, ["iam_drill_x"]);
});

test("runRestoreDrill: refuses to run when scratch name equals the live DB (never touch live)", async () => {
  const { deps, created } = fakeDeps({ scratchName: "iam", liveDbName: "iam" });
  const r = await runRestoreDrill(deps);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /must differ from the live DB/);
  assert.deepEqual(created, []); // nothing was created
});

test("runRestoreDrill: a checksum mismatch on the blob copy fails before restoring", async () => {
  const { deps, created } = fakeDeps({
    acquireDump: async () => ({ path: "/tmp/blob.dump", source: "blob", checksumOk: false }),
  });
  const r = await runRestoreDrill(deps);
  assert.equal(r.ok, false);
  assert.equal(r.checksumOk, false);
  assert.match(r.error ?? "", /checksum/);
  assert.deepEqual(created, []);
});

// --- staleness alert throttle ----------------------------------------------------------------------
test("computeStalenessAlert: fresh backup never alerts; stale alerts once, then throttled 24h", () => {
  const now = new Date("2026-07-22T12:00:00Z");
  assert.equal(computeStalenessAlert(false, undefined, now).shouldAlert, false);
  assert.equal(computeStalenessAlert(true, undefined, now).shouldAlert, true); // never alerted -> fire
  // alerted 1h ago -> throttled
  assert.equal(computeStalenessAlert(true, new Date(now.getTime() - 3_600_000).toISOString(), now).shouldAlert, false);
  // alerted 25h ago -> fire again
  assert.equal(computeStalenessAlert(true, new Date(now.getTime() - 25 * 3_600_000).toISOString(), now).shouldAlert, true);
  // unparseable last-alert stamp -> fire (fail toward alerting)
  assert.equal(computeStalenessAlert(true, "nope", now).shouldAlert, true);
});

// --- url + name helpers ----------------------------------------------------------------------------
test("pgUrlsFromEnv: derives db name, maintenance + scratch urls, keeps query, swaps only the db", () => {
  const u = pgUrlsFromEnv("postgresql://user:p%40ss@host:5432/iam?schema=public&sslmode=require");
  assert.equal(u.dbName, "iam");
  assert.match(u.maintUrl, /\/postgres\?/); // maintenance DB
  assert.match(u.maintUrl, /sslmode=require/); // connection params survive
  assert.ok(!/schema=public/.test(u.maintUrl)); // only Prisma's schema param is dropped
  assert.match(u.scratchUrl("iam_drill_abc"), /\/iam_drill_abc\?/);
});

test("scratchDbName: unique, prefixed, and never the bare live name", () => {
  const a = scratchDbName("iam");
  const b = scratchDbName("iam");
  assert.match(a, /^iam_drill_/);
  assert.notEqual(a, "iam");
  assert.notEqual(a, b); // random suffix -> collision-free across concurrent drills
});

test("restoreDrillStatus: projection fills defaults", () => {
  const st = restoreDrillStatus(null);
  assert.equal(st.enabled, true);
  assert.equal(st.dayOfWeek, 0);
  assert.equal(st.hourLocal, 3);
  assert.equal(st.lastStartedAt, null);
  assert.equal(st.lastResult, null);
});
