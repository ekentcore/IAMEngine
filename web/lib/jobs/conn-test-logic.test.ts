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
    { state: "verified", total: 2 }
  );
  // any definite miss wins over unverified
  assert.deepEqual(
    summarizeRights([{ op: "a", ok: false, detail: "" }, { op: "b", ok: null, detail: "" }]),
    { state: "missing", missing: 1, total: 2 }
  );
  assert.deepEqual(
    summarizeRights([{ op: "a", ok: true, detail: "" }, { op: "b", ok: null, detail: "" }]),
    { state: "unverified", unverified: 1, total: 2 }
  );
});
