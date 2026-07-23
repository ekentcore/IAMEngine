import { test } from "node:test";
import assert from "node:assert/strict";
import {
  secretRefHash, computeBaseline, diffTables, verifyDbMove, chooseSampleRefs, sampleDelinea,
  type DbSnapshot, type SecretRefTriple, type DelineaSample,
} from "./cutover-db";
import type { DelineaConfig, Fetcher, FetchResponse } from "@/lib/secrets/delinea";

const refs = (arr: [string | null, string, string][]): SecretRefTriple[] => arr.map(([clientId, name, externalId]) => ({ clientId, name, externalId }));

// ── secretRefHash ─────────────────────────────────────────────────────────────────────────────────
test("secretRefHash is order-independent (sorted before hashing)", () => {
  const a = refs([["c1", "m365", "100"], ["c2", "ad", "200"]]);
  const b = refs([["c2", "ad", "200"], ["c1", "m365", "100"]]);
  assert.equal(secretRefHash(a), secretRefHash(b));
});

test("secretRefHash changes when any reference is dropped or rewritten", () => {
  const base = refs([["c1", "m365", "100"], ["c2", "ad", "200"]]);
  assert.notEqual(secretRefHash(base), secretRefHash(refs([["c1", "m365", "100"]]))); // dropped
  assert.notEqual(secretRefHash(base), secretRefHash(refs([["c1", "m365", "999"], ["c2", "ad", "200"]]))); // rewritten externalId
  assert.notEqual(secretRefHash(base), secretRefHash(refs([["c1", "m365", "100"], ["c2", "ad", "200"], ["c3", "x", "300"]]))); // added
});

test("computeBaseline captures counts, secretCount, and the hash", () => {
  const snap: DbSnapshot = { tables: { Client: 5, Secret: 2 }, secretRefs: refs([["c1", "m365", "100"], ["c2", "ad", "200"]]) };
  const b = computeBaseline(snap, new Date("2026-07-23T00:00:00Z"));
  assert.equal(b.secretCount, 2);
  assert.equal(b.tables.Client, 5);
  assert.equal(b.secretRefHash, secretRefHash(snap.secretRefs));
  assert.equal(b.capturedAt, "2026-07-23T00:00:00.000Z");
});

// ── diffTables ──────────────────────────────────────────────────────────────────────────────────
test("diffTables: exact match on every table → all ok", () => {
  const rows = diffTables({ Client: 5, Job: 10 }, { Client: 5, Job: 10 });
  assert.equal(rows.every((r) => r.ok && r.status === "match"), true);
});

test("diffTables: a shrink is always a failure (data loss)", () => {
  const rows = diffTables({ Client: 5 }, { Client: 4 });
  assert.equal(rows[0].status, "shrank");
  assert.equal(rows[0].ok, false);
});

test("diffTables: growth on a volatile table is ok; growth elsewhere fails", () => {
  const rows = diffTables({ AuditLog: 100, Client: 5 }, { AuditLog: 130, Client: 6 });
  const audit = rows.find((r) => r.name === "AuditLog")!;
  const client = rows.find((r) => r.name === "Client")!;
  assert.equal(audit.status, "grew");
  assert.equal(audit.ok, true); // volatile — append-only on a live app
  assert.equal(client.status, "grew");
  assert.equal(client.ok, false); // config table shouldn't gain rows during a frozen cutover
});

test("diffTables: a baseline table missing on the target is a structural loss", () => {
  const rows = diffTables({ Client: 5, Secret: 2 }, { Client: 5 });
  const secret = rows.find((r) => r.name === "Secret")!;
  assert.equal(secret.status, "missing");
  assert.equal(secret.ok, false);
});

// ── verifyDbMove: ok derivation ───────────────────────────────────────────────────────────────────
const baseSnap: DbSnapshot = { tables: { Client: 5, Secret: 2 }, secretRefs: refs([["c1", "m365", "100"], ["c2", "ad", "200"]]) };
const baseline = computeBaseline(baseSnap);
const goodDelinea: DelineaSample = { configured: true, reachable: true, sampled: 2, resolvable: 2, unresolvable: [] };

test("verifyDbMove: counts match + refs match + delinea reachable + zero unresolvable → ok", () => {
  const r = verifyDbMove({ baseline, current: baseSnap, delinea: goodDelinea });
  assert.equal(r.ok, true);
  assert.equal(r.secretRefMatch, true);
  assert.equal(r.delineaReachable, true);
});

test("verifyDbMove: a changed reference set fails even with matching counts", () => {
  const current: DbSnapshot = { tables: { Client: 5, Secret: 2 }, secretRefs: refs([["c1", "m365", "100"], ["c2", "ad", "999"]]) };
  const r = verifyDbMove({ baseline, current, delinea: goodDelinea });
  assert.equal(r.ok, false);
  assert.equal(r.secretRefMatch, false);
});

test("verifyDbMove: an unresolvable secret fails the verdict", () => {
  const delinea: DelineaSample = { configured: true, reachable: true, sampled: 2, resolvable: 1, unresolvable: [{ clientId: "c2", name: "ad", error: "not found in Delinea" }] };
  const r = verifyDbMove({ baseline, current: baseSnap, delinea });
  assert.equal(r.ok, false);
  assert.equal(r.unresolvable.length, 1);
});

// D1: this is the load-bearing safety property — Delinea unreachable must read RED, never green.
test("verifyDbMove: Delinea UNREACHABLE (D1) → NOT ok, even with perfect counts + refs", () => {
  const unreachable: DelineaSample = { configured: true, reachable: false, sampled: 0, resolvable: 0, unresolvable: [], error: "connect ETIMEDOUT" };
  const r = verifyDbMove({ baseline, current: baseSnap, delinea: unreachable });
  assert.equal(r.ok, false, "must not pretend success when secrets can't be resolved from the new host");
  assert.equal(r.delineaReachable, false);
  assert.match(r.note ?? "", /not reachable from this host/i);
});

test("verifyDbMove: Delinea NOT CONFIGURED on the new host → NOT ok, clear note", () => {
  const notConfigured: DelineaSample = { configured: false, reachable: false, sampled: 0, resolvable: 0, unresolvable: [] };
  const r = verifyDbMove({ baseline, current: baseSnap, delinea: notConfigured });
  assert.equal(r.ok, false);
  assert.match(r.note ?? "", /not configured/i);
});

test("verifyDbMove: null delinea sample (not attempted) → NOT ok", () => {
  const r = verifyDbMove({ baseline, current: baseSnap, delinea: null });
  assert.equal(r.ok, false);
});

// ── chooseSampleRefs ────────────────────────────────────────────────────────────────────────────
test("chooseSampleRefs: always includes GA/app-reg secrets + bounds the per-client rest", () => {
  const all = refs([
    ["c1", "m365-appreg", "1"], ["c1", "mailbox", "2"], ["c1", "printer", "3"], ["c1", "vpn", "4"],
    ["c2", "graph-app", "5"], ["c2", "smb", "6"],
  ]);
  const chosen = chooseSampleRefs(all, 2);
  // both GA-ish secrets kept regardless of the per-client cap
  assert.ok(chosen.some((r) => r.externalId === "1"));
  assert.ok(chosen.some((r) => r.externalId === "5"));
  // c1 non-GA capped at 2 (mailbox, printer) — vpn dropped
  assert.equal(chosen.filter((r) => r.clientId === "c1" && !/appreg/.test(r.name)).length, 2);
  assert.ok(!chosen.some((r) => r.externalId === "4"));
});

// ── sampleDelinea (Fetcher seam) ──────────────────────────────────────────────────────────────────
const CFG: DelineaConfig = { baseUrl: "https://vault.example", username: "svc", password: "pw" };
function jsonRes(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("sampleDelinea: not configured → configured:false, nothing sampled", async () => {
  const s = await sampleDelinea({ baseUrl: "", username: "", password: "" }, refs([["c1", "m", "1"]]));
  assert.deepEqual(s, { configured: false, reachable: false, sampled: 0, resolvable: 0, unresolvable: [] });
});

test("sampleDelinea: token fails (no egress from new host) → reachable:false with error (D1)", async () => {
  const fetcher: Fetcher = async (url) => (url.includes("/oauth2/token") ? jsonRes(503, {}) : jsonRes(200, {}));
  const s = await sampleDelinea(CFG, refs([["c1", "m365", "1"]]), fetcher);
  assert.equal(s.configured, true);
  assert.equal(s.reachable, false);
  assert.equal(s.sampled, 0);
  assert.match(s.error ?? "", /503/);
});

test("sampleDelinea: aggregates resolvable vs unresolvable per secret", async () => {
  const fetcher: Fetcher = async (url) => {
    if (url.includes("/oauth2/token")) return jsonRes(200, { access_token: "t" });
    if (url.includes("/secrets/1/summary")) return jsonRes(200, { name: "ok-secret" });
    if (url.includes("/secrets/2/summary")) return jsonRes(404, {});
    return jsonRes(500, {});
  };
  const s = await sampleDelinea(CFG, refs([["c1", "m365-appreg", "1"], ["c1", "ad", "2"]]), fetcher, { perClient: 5 });
  assert.equal(s.reachable, true);
  assert.equal(s.sampled, 2);
  assert.equal(s.resolvable, 1);
  assert.equal(s.unresolvable.length, 1);
  assert.equal(s.unresolvable[0].name, "ad");
  assert.match(s.unresolvable[0].error, /not found/i);
});
