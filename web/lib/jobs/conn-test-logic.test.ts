import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotNeededForTest, parseRights, summarizeRights, testableSystems, type TestableSystemInput } from "./conn-test-logic";
import { NOT_NEEDED } from "../cases/case-secrets";

function sys(over: Partial<TestableSystemInput> & { systemKey: string }): TestableSystemInput {
  return { mode: "api", secretNames: ["s"], config: null, ...over };
}

test("testableSystems: api systems with secrets only", () => {
  const rows = testableSystems(
    [
      sys({ systemKey: "m365" }),
      sys({ systemKey: "duo", mode: "manual" }),
      sys({ systemKey: "zoom", secretNames: [] }),
      sys({ systemKey: "jira", secretNames: null }),
    ],
    false
  );
  assert.deepEqual(rows.map((r) => r.systemKey), ["m365"]);
});

test("testableSystems: scoped to one system", () => {
  const all = [sys({ systemKey: "m365" }), sys({ systemKey: "mimecast" })];
  const rows = testableSystems(all, false, "mimecast");
  assert.deepEqual(rows.map((r) => r.systemKey), ["mimecast"]);
  // scoping to a non-testable/unknown key yields nothing (callers turn that into a 404/422)
  assert.deepEqual(testableSystems(all, false, "nope"), []);
});

test("testableSystems: onPrem stamping follows systemIsOnPrem", () => {
  const rows = testableSystems(
    [sys({ systemKey: "active-directory" }), sys({ systemKey: "exchange" }), sys({ systemKey: "m365" })],
    true
  );
  const byKey = new Map(rows.map((r) => [r.systemKey, r.onPrem]));
  assert.equal(byKey.get("active-directory"), true);
  assert.equal(byKey.get("exchange"), true); // hybrid: exchange is on-prem when the client has AD
  assert.equal(byKey.get("m365"), false);
  const cloudOnly = testableSystems([sys({ systemKey: "exchange" })], false);
  assert.equal(cloudOnly[0].onPrem, false);
});

// FR #24: an on-prem AD / directory-sync system whose ONLY secret is the OPTIONAL ad-dc must still be
// tested — the runner authenticates as ambient SYSTEM on a domain controller and needs no credential —
// and ad-dc must NOT ride in the row's required secretNames. If it does, the runner brokers it up
// front, a not-needed/unwired ad-dc fails that broker, and the AD probe (the real Get-ADDomain call
// that proves the agent works) never runs, so a correctly-set-up client with an agent reads not-ready.
test("testableSystems: an optional-only secret (ad-dc) keeps the system testable but is NOT required", () => {
  const rows = testableSystems(
    [sys({ systemKey: "active-directory", secretNames: ["ad-dc"] }), sys({ systemKey: "directory-sync", secretNames: ["ad-dc"] })],
    true
  );
  // both systems are still enqueued for a test (they connect to AD via ambient auth)…
  assert.deepEqual(rows.map((r) => r.systemKey).sort(), ["active-directory", "directory-sync"]);
  // …but the optional ad-dc is stripped from the REQUIRED secretNames on every row.
  for (const r of rows) assert.deepEqual(r.secretNames, [], `${r.systemKey} must not require the optional ad-dc`);
});

test("testableSystems: a required secret alongside an optional one keeps only the required one", () => {
  // A member-server AD lane could list both a real required secret and ad-dc; only ad-dc is stripped.
  const rows = testableSystems([sys({ systemKey: "active-directory", secretNames: ["ad-svc", "ad-dc"] })], true);
  assert.deepEqual(rows[0].secretNames, ["ad-svc"]);
});

// A system whose every REQUIRED secret is marked NOT_NEEDED is a manual step — there's nothing to
// connect to, so it must be surfaced as a read-only "not needed" row, never dispatched to a runner
// (which would only fail the broker with "secret is marked not needed — nothing to test").
test("isNotNeededForTest: true only when every required secret is NOT_NEEDED", () => {
  assert.equal(isNotNeededForTest(["a"], new Map([["a", NOT_NEEDED]])), true);
  assert.equal(isNotNeededForTest(["a", "b"], new Map([["a", NOT_NEEDED], ["b", NOT_NEEDED]])), true);
  // any required secret with a real (or unset) reference means it still connects to something
  assert.equal(isNotNeededForTest(["a", "b"], new Map([["a", NOT_NEEDED], ["b", "1234"]])), false);
  assert.equal(isNotNeededForTest(["a"], new Map([["a", null]])), false);
  assert.equal(isNotNeededForTest(["a"], new Map()), false);
  assert.equal(isNotNeededForTest([], new Map()), false);
  assert.equal(isNotNeededForTest(null, new Map()), false);
});

test("isNotNeededForTest: an OPTIONAL secret is ignored when deciding not-needed", () => {
  // ad-dc is optional; an AD system whose ONLY secret is a not-needed ad-dc still connects via ambient
  // auth, so it is NOT not-needed (there's a real Get-ADDomain probe to run).
  assert.equal(isNotNeededForTest(["ad-dc"], new Map([["ad-dc", NOT_NEEDED]])), false);
  // a required secret marked not-needed IS not-needed even if a not-needed optional rides alongside it.
  assert.equal(isNotNeededForTest(["ad-svc", "ad-dc"], new Map([["ad-svc", NOT_NEEDED], ["ad-dc", NOT_NEEDED]])), true);
});

test("testableSystems: excludes not-needed systems when secret references are provided", () => {
  const systems = [sys({ systemKey: "m365", secretNames: ["m365-app"] }), sys({ systemKey: "mimecast", secretNames: ["mc"] })];
  const ext = new Map<string, string | null>([["m365-app", "9999"], ["mc", NOT_NEEDED]]);
  // with references: the not-needed mimecast drops out, only m365 is dispatched
  assert.deepEqual(testableSystems(systems, false, undefined, ext).map((r) => r.systemKey), ["m365"]);
  // without references (older callers): behaviour unchanged — both systems are testable
  assert.deepEqual(testableSystems(systems, false).map((r) => r.systemKey).sort(), ["m365", "mimecast"]);
});

test("parseRights: normalizes, drops malformed, caps detail", () => {
  const rows = parseRights([
    { op: "create users", ok: true, detail: "granted" },
    { op: "read licenses", ok: false, detail: "x".repeat(500) },
    { op: "verify manually", detail: "no introspection API" }, // no ok -> null
    { op: "", ok: true, detail: "dropped: empty op" },
    "garbage",
    null,
  ]);
  assert.ok(rows);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { op: "create users", ok: true, detail: "granted" });
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].detail.length, 300);
  assert.equal(rows[2].ok, null);
});

test("parseRights: null for non-arrays and empty/unusable arrays", () => {
  assert.equal(parseRights(undefined), null);
  assert.equal(parseRights("nope"), null);
  assert.equal(parseRights([]), null);
  assert.equal(parseRights([{ ok: true }]), null);
});

test("summarizeRights: verified / missing / unverified / unknown", () => {
  assert.deepEqual(summarizeRights(null), { state: "unknown" });
  assert.deepEqual(summarizeRights([]), { state: "unknown" });
  assert.deepEqual(
    summarizeRights([{ op: "a", ok: true, detail: "" }, { op: "b", ok: true, detail: "" }]),
    { state: "verified", total: 2, optionalMissing: 0, surplus: 0, escalation: 0 }
  );
  // any definite miss wins over unverified
  assert.deepEqual(
    summarizeRights([{ op: "a", ok: false, detail: "" }, { op: "b", ok: null, detail: "" }]),
    { state: "missing", missing: 1, total: 2, optionalMissing: 0, surplus: 0, escalation: 0 }
  );
  assert.deepEqual(
    summarizeRights([{ op: "a", ok: true, detail: "" }, { op: "b", ok: null, detail: "" }]),
    { state: "unverified", unverified: 1, total: 2, optionalMissing: 0, surplus: 0, escalation: 0 }
  );
});

test("summarizeRights: a missing OPTIONAL op is noted, never a failure", () => {
  // all required present + one optional missing -> still verified, with an optionalMissing note.
  assert.deepEqual(
    summarizeRights([
      { op: "create users", ok: true, detail: "" },
      { op: "remove MFA", ok: false, detail: "", optional: true },
    ]),
    { state: "verified", total: 1, optionalMissing: 1, surplus: 0, escalation: 0 }
  );
  // a granted optional doesn't inflate the required total, and isn't counted as missing.
  assert.deepEqual(
    summarizeRights([
      { op: "create users", ok: true, detail: "" },
      { op: "remove MFA", ok: true, detail: "", optional: true },
    ]),
    { state: "verified", total: 1, optionalMissing: 0, surplus: 0, escalation: 0 }
  );
  // a real required miss still wins, and the optional miss is reported alongside it.
  assert.deepEqual(
    summarizeRights([
      { op: "create users", ok: false, detail: "" },
      { op: "remove MFA", ok: false, detail: "", optional: true },
    ]),
    { state: "missing", missing: 1, total: 1, optionalMissing: 1, surplus: 0, escalation: 0 }
  );
});

test("parseRights: carries the optional flag through, only when true", () => {
  const rows = parseRights([
    { op: "required", ok: true, detail: "" },
    { op: "opt", ok: false, detail: "", optional: true },
    { op: "not-opt", ok: true, detail: "", optional: false },
  ]);
  assert.ok(rows);
  assert.equal(rows[0].optional, undefined);
  assert.equal(rows[1].optional, true);
  assert.equal(rows[2].optional, undefined);
});

// ── Over-permissioning ───────────────────────────────────────────────────────────────────────────
// Surplus rows report the OPPOSITE of a gap: authority the credential has and we never use. They ride
// the same wire as optional rows, so the risk is a report that means the reverse of itself.

test("a surplus row never fails a test, and never turns the badge red", () => {
  const s = summarizeRights([
    { op: "create / update users", ok: true, detail: "granted via User.ReadWrite.All" },
    { op: "OVER-PERMISSIONED: RoleManagement.ReadWrite.Directory", ok: false, detail: "…", optional: true, surplus: true },
  ]);
  assert.equal(s.state, "verified");
  assert.equal(s.state === "verified" && s.surplus, 1);
});

test("a surplus row is NOT counted as a missing optional permission", () => {
  // "+3 optional" about permissions there are too MANY of reads as the exact opposite of the truth.
  const s = summarizeRights([
    { op: "create / update users", ok: true, detail: "" },
    { op: "remove MFA methods", ok: false, detail: "", optional: true },
    { op: "OVER-PERMISSIONED: Application.ReadWrite.All", ok: false, detail: "", optional: true, surplus: true },
    { op: "not needed: Files.Read.All", ok: false, detail: "", optional: true, surplus: true },
  ]);
  assert.equal(s.state === "verified" && s.optionalMissing, 1); // the MFA row only
  assert.equal(s.state === "verified" && s.surplus, 2);
});

test("parseRights carries surplus through, and forces it optional so it can never fail", () => {
  const rows = parseRights([{ op: "OVER-PERMISSIONED: full_access_as_app", ok: false, detail: "x", surplus: true }])!;
  assert.equal(rows[0].surplus, true);
  assert.equal(rows[0].optional, true, "a surplus row must never be able to fail a test");
});

test("a probe reporting ONLY surplus rows is not 'missing everything'", () => {
  // The all-optional fallback would otherwise treat surplus rows as the base set and report a working
  // credential as failing — precisely backwards.
  const s = summarizeRights([{ op: "OVER-PERMISSIONED: full_access_as_app", ok: false, detail: "", optional: true, surplus: true }]);
  assert.equal(s.state, "verified");
  assert.equal(s.state === "verified" && s.surplus, 1);
});

test("the rights cap fits a real tenant's rows — 3 required + 7 optional + surplus", () => {
  // Was 20; coretelligent alone reports ~17 and a silent slice drops findings off the end.
  const many = Array.from({ length: 30 }, (_, i) => ({ op: `op${i}`, ok: true, detail: "" }));
  assert.equal(parseRights(many)!.length, 30);
});

// ── Escalation (a subset of surplus that is a genuine privilege-escalation risk) ────────────────────

test("parseRights: derives escalation from the op prefix and strips the known prefix", () => {
  const rows = parseRights([
    { op: "OVER-PERMISSIONED: RoleManagement.ReadWrite.Directory", ok: false, detail: "can self-assign Global Admin", surplus: true },
    { op: "not needed: Files.Read.All", ok: false, detail: "unused", surplus: true },
  ])!;
  assert.equal(rows[0].op, "RoleManagement.ReadWrite.Directory");
  assert.equal(rows[0].escalation, true);
  assert.equal(rows[1].op, "Files.Read.All");
  assert.equal(rows[1].escalation, false);
});

test("parseRights: an explicit wire escalation field wins over the prefix parse", () => {
  const rows = parseRights([
    { op: "OVER-PERMISSIONED: X", ok: false, detail: "", surplus: true, escalation: false },
  ])!;
  assert.equal(rows[0].escalation, false); // explicit false beats the prefix's implied true
});

test("parseRights: a non-surplus row is never given an escalation prefix strip", () => {
  const rows = parseRights([{ op: "OVER-PERMISSIONED: looks like a prefix but isn't surplus", ok: true, detail: "" }])!;
  assert.equal(rows[0].op, "OVER-PERMISSIONED: looks like a prefix but isn't surplus");
  assert.equal(rows[0].escalation, undefined);
});

test("a credential can be BOTH under- and over-permissioned at once", () => {
  const s = summarizeRights(
    parseRights([
      { op: "create users", ok: false, detail: "" }, // required, missing
      { op: "OVER-PERMISSIONED: RoleManagement.ReadWrite.Directory", ok: false, detail: "", surplus: true },
      { op: "not needed: Files.Read.All", ok: false, detail: "", surplus: true },
    ])
  );
  assert.equal(s.state, "missing");
  assert.equal(s.state === "missing" && s.missing, 1);
  assert.equal(s.state === "missing" && s.surplus, 2);
  assert.equal(s.state === "missing" && s.escalation, 1);
});

test("summarizeRights: escalation count reflects only escalation surplus rows, not all surplus", () => {
  const s = summarizeRights([
    { op: "create users", ok: true, detail: "" },
    { op: "A", ok: false, detail: "", optional: true, surplus: true, escalation: true },
    { op: "B", ok: false, detail: "", optional: true, surplus: true, escalation: false },
    { op: "C", ok: false, detail: "", optional: true, surplus: true },
  ]);
  assert.equal(s.state === "verified" && s.surplus, 3);
  assert.equal(s.state === "verified" && s.escalation, 1);
});
