import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRights, summarizeRights, testableSystems, type TestableSystemInput } from "./conn-test-logic";

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
