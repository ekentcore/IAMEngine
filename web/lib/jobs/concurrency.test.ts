import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitUnderCaps,
  resolveCaps,
  governorActive,
  groupKey,
  DEFAULT_CAPS,
  type ConcurrencyCaps,
  type Inflight,
  type AdmitInput,
} from "./concurrency";

// A candidate id is "<tenant>:<system>:<n>" so the mapping helpers can be derived from the id itself,
// keeping each test's setup to a single array of ids. `exempt` ids carry a trailing ":x".
function inputFrom(ids: string[], caps: ConcurrencyCaps, inflight?: Partial<Inflight>): AdmitInput {
  const parse = (id: string) => {
    const [tenant, system] = id.split(":");
    return { tenant, system, exempt: id.endsWith(":x") };
  };
  return {
    eligible: ids,
    tenantOf: (id) => parse(id).tenant,
    systemKeyOf: (id) => parse(id).system,
    exemptOf: (id) => parse(id).exempt,
    caps,
    inflight: { global: 0, byTenant: {}, byTenantSystem: {}, ...inflight },
  };
}

const ON: ConcurrencyCaps = { enabled: true, globalMax: 20, perTenantMax: 3, perSystemMax: 1 };

test("empty eligible -> empty admit", () => {
  const r = admitUnderCaps(inputFrom([], ON));
  assert.deepEqual(r.ids, []);
  assert.deepEqual(r.skipped, []);
});

test("governor disabled -> admit everything, no accounting", () => {
  const ids = ["acme:m365:1", "acme:m365:2", "acme:m365:3"]; // would violate (d) if on
  const r = admitUnderCaps(inputFrom(ids, { ...ON, enabled: false }));
  assert.deepEqual(r.ids, ids);
  assert.equal(r.skipped.length, 0);
});

test("rule (d): only ONE job per (tenant, system) admitted within a batch", () => {
  const r = admitUnderCaps(inputFrom(["acme:m365:1", "acme:m365:2", "acme:m365:3"], ON));
  assert.deepEqual(r.ids, ["acme:m365:1"]);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].reason, /shared-session collision/);
});

test("rule (d): different systems for the same tenant each get a slot", () => {
  const r = admitUnderCaps(inputFrom(["acme:m365:1", "acme:egnyte:1", "acme:zoom:1"], ON));
  assert.deepEqual(r.ids, ["acme:m365:1", "acme:egnyte:1", "acme:zoom:1"]);
});

test("rule (d) honors an already in-flight group from the DB count", () => {
  const inflight: Partial<Inflight> = {
    global: 1,
    byTenant: { acme: 1 },
    byTenantSystem: { [groupKey("acme", "m365")]: 1 },
  };
  const r = admitUnderCaps(inputFrom(["acme:m365:1", "acme:egnyte:1"], ON, inflight));
  assert.deepEqual(r.ids, ["acme:egnyte:1"]); // m365 already in flight -> held
});

test("rule (c): per-tenant cap fills exactly perTenantMax then skips, independent across tenants", () => {
  const caps = { ...ON, perTenantMax: 2 };
  const ids = ["acme:a:1", "acme:b:1", "acme:c:1", "beta:a:1", "beta:b:1", "beta:c:1"];
  const r = admitUnderCaps(inputFrom(ids, caps));
  assert.deepEqual(r.ids, ["acme:a:1", "acme:b:1", "beta:a:1", "beta:b:1"]);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].reason, /this client is at capacity/);
});

test("rule (b): global cap fills exactly globalMax then skips", () => {
  const caps = { ...ON, globalMax: 2, perTenantMax: 99 };
  const ids = ["a:s:1", "b:s:1", "c:s:1"]; // distinct tenants+systems so only global bites
  const r = admitUnderCaps(inputFrom(ids, caps));
  assert.deepEqual(r.ids, ["a:s:1", "b:s:1"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /fleet at capacity/);
});

test("global cap accounts for jobs already in flight", () => {
  const caps = { ...ON, globalMax: 2, perTenantMax: 99 };
  const r = admitUnderCaps(inputFrom(["a:s:1", "b:s:1"], caps, { global: 1 }));
  assert.deepEqual(r.ids, ["a:s:1"]); // one slot left globally
});

test("order preserved: the earliest eligible id wins a scarce slot", () => {
  const caps = { ...ON, globalMax: 1, perTenantMax: 99 };
  const r = admitUnderCaps(inputFrom(["z:s:1", "a:s:1"], caps));
  assert.deepEqual(r.ids, ["z:s:1"]); // input order, NOT sorted
});

test("running budgets decrement across a mixed batch", () => {
  // perTenant=2, perSystem=1. acme: m365(ok), egnyte(ok), zoom(skip-tenant-full). beta independent.
  const caps = { ...ON, perTenantMax: 2 };
  const ids = ["acme:m365:1", "acme:egnyte:1", "acme:zoom:1", "beta:m365:1"];
  const r = admitUnderCaps(inputFrom(ids, caps));
  assert.deepEqual(r.ids, ["acme:m365:1", "acme:egnyte:1", "beta:m365:1"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /this client is at capacity/);
});

test("exempt (ad-hoc/singleRun) jobs are never blocked by a cap", () => {
  const caps = { ...ON, globalMax: 1, perTenantMax: 1 };
  // Global already at cap and a same-group job in flight; the exempt job still gets through.
  const inflight: Partial<Inflight> = {
    global: 1,
    byTenant: { acme: 1 },
    byTenantSystem: { [groupKey("acme", "m365")]: 1 },
  };
  const r = admitUnderCaps(inputFrom(["acme:m365:x"], caps, inflight));
  assert.deepEqual(r.ids, ["acme:m365:x"]);
});

test("an exempt job still consumes budget, holding a NON-exempt sibling for the same group", () => {
  const r = admitUnderCaps(inputFrom(["acme:m365:x", "acme:m365:2"], ON));
  assert.deepEqual(r.ids, ["acme:m365:x"]); // exempt admitted; normal sibling held by (d)
  assert.equal(r.skipped.length, 1);
});

test("perSystemMax > 1 permits that many per group", () => {
  const caps = { ...ON, perSystemMax: 2, perTenantMax: 99 };
  const r = admitUnderCaps(inputFrom(["acme:m365:1", "acme:m365:2", "acme:m365:3"], caps));
  assert.deepEqual(r.ids, ["acme:m365:1", "acme:m365:2"]);
});

// ---- resolveCaps (fail-open config resolver) --------------------------------------------------

test("resolveCaps: null / undefined -> defaults (governor OFF)", () => {
  assert.deepEqual(resolveCaps(null), DEFAULT_CAPS);
  assert.deepEqual(resolveCaps(undefined), DEFAULT_CAPS);
  assert.equal(DEFAULT_CAPS.enabled, false); // ships dark
});

test("resolveCaps: non-object -> defaults", () => {
  assert.deepEqual(resolveCaps("garbage" as never), DEFAULT_CAPS);
});

test("resolveCaps: enabled only when strictly true", () => {
  assert.equal(resolveCaps({ enabled: true }).enabled, true);
  assert.equal(resolveCaps({ enabled: false }).enabled, false);
  assert.equal(resolveCaps({}).enabled, false); // omitted -> off
  assert.equal(resolveCaps({ enabled: 1 as never }).enabled, false);
});

test("resolveCaps: negative / non-finite / non-number caps fall back to defaults (never pin at 0)", () => {
  const r = resolveCaps({ enabled: true, globalMax: -5, perTenantMax: NaN as never, perSystemMax: "x" as never });
  assert.equal(r.globalMax, DEFAULT_CAPS.globalMax);
  assert.equal(r.perTenantMax, DEFAULT_CAPS.perTenantMax);
  assert.equal(r.perSystemMax, DEFAULT_CAPS.perSystemMax);
});

test("resolveCaps: valid overrides are honored (and floored)", () => {
  const r = resolveCaps({ enabled: true, globalMax: 5, perTenantMax: 2, perSystemMax: 1.9 });
  assert.deepEqual(r, { enabled: true, globalMax: 5, perTenantMax: 2, perSystemMax: 1 });
});

test("governorActive mirrors caps.enabled (the S7 signal for the runner pool)", () => {
  assert.equal(governorActive(resolveCaps({ enabled: true })), true);
  assert.equal(governorActive(resolveCaps(null)), false);
});
