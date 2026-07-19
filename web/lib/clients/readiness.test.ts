import { test } from "node:test";
import assert from "node:assert/strict";
import { computeClientReadiness } from "./readiness";
import { NOT_NEEDED } from "../cases/case-secrets";

const sys = (systemKey: string, secretNames: string[]) => ({ systemKey, secretNames });

test("ready: every credentialed system wired and tested ok", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("mimecast", ["mimecast"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["mimecast", "222"]]),
    testBySystem: new Map([["m365", "ok"], ["mimecast", "ok"]]),
  });
  assert.equal(r.tier, "ready");
  assert.equal(r.systemsReady, 2);
});

test("not_set_up: nothing wired", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("mimecast", ["mimecast"])],
    secretExternalIds: new Map([["m365-admin", ""], ["mimecast", "REPLACE_ME"]]),
    testBySystem: new Map(),
  });
  assert.equal(r.tier, "not_set_up");
  assert.equal(r.systemsWired, 0);
});

test("partial: core wired+ok but some missing/untested/failing", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("mimecast", ["mimecast"]), sys("spanning", ["spanning"]), sys("adobe", ["adobe"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["mimecast", "222"], ["spanning", "333"], ["adobe", ""]]),
    testBySystem: new Map([["m365", "ok"], ["mimecast", "fail"], ["spanning", "untested"]]),
  });
  assert.equal(r.tier, "partial");
  assert.equal(r.systemsReady, 1);       // only m365 wired+ok
  assert.match(r.summary, /1 of 4 ready/);
  assert.match(r.summary, /1 missing creds/); // adobe (a genuinely-required secret)
  assert.match(r.summary, /1 untested/);      // spanning
  assert.match(r.summary, /1 failing/);       // mimecast
});

// ad-dc is OPTIONAL for AD (the agent runs ambient SYSTEM on a DC), so an unset ad-dc must NOT count
// as a missing credential — the AD system reads as wired and merely untested, not "missing creds".
test("an unset ad-dc does not make Active Directory read as missing creds (optional)", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("active-directory", ["ad-dc"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["ad-dc", ""]]),
    testBySystem: new Map([["m365", "ok"], ["active-directory", "ok"]]),
  });
  assert.equal(r.systemsReady, 2, "AD is ready on ambient SYSTEM without ad-dc");
  assert.doesNotMatch(r.summary, /missing creds/);
});

test("NOT_NEEDED counts as wired (manual-step module)", () => {
  const r = computeClientReadiness({
    systems: [sys("1password", ["1password"])],
    secretExternalIds: new Map([["1password", NOT_NEEDED]]),
    testBySystem: new Map([["1password", "ok"]]),
  });
  assert.equal(r.tier, "ready");
});

test("a NOT_NEEDED system reads 'not needed' + ready even if a stale test says fail (no partial)", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("1password", ["1password"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["1password", NOT_NEEDED]]),
    testBySystem: new Map([["m365", "ok"], ["1password", "fail"]]), // stale/irrelevant fail on the manual system
  });
  const pw = r.systems.find((s) => s.systemKey === "1password")!;
  assert.equal(pw.notNeeded, true);
  assert.equal(pw.test, "not_needed"); // not "fail"
  assert.equal(pw.ready, true);
  assert.equal(r.tier, "ready"); // was "partial" before the fix
  assert.match(r.summary, /manual steps/);
});

test("no_systems: no credentialed systems modeled", () => {
  const r = computeClientReadiness({ systems: [], secretExternalIds: new Map(), testBySystem: new Map() });
  assert.equal(r.tier, "no_systems");
});

// --- Setup stage vector --------------------------------------------------------------------------

test("setup vector: legacy inputs (no setup/preflight/rights maps) derive with unknowns, not failures", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"])],
    secretExternalIds: new Map([["m365-admin", "111"]]),
    testBySystem: new Map([["m365", "ok"]]),
  });
  const v = r.systems[0].setup;
  assert.equal(v.started, "done");     // implied by wired + test evidence
  assert.equal(v.wired, "done");
  assert.equal(v.preflight, "unknown"); // absent map -> unknown, never failed
  assert.equal(v.test, "done");
  assert.equal(v.rights, "unknown");
  assert.equal(v.complete, true);      // ready and nothing DEFINITELY failed
});

test("setup vector: full pipeline states (preflight fail, rights missing, attestation overlay)", () => {
  const base = {
    systems: [sys("m365", ["m365-admin"])],
    secretExternalIds: new Map([["m365-admin", "111"]]),
    testBySystem: new Map([["m365", "fail" as const]]),
  };
  const failed = computeClientReadiness({
    ...base,
    preflightBySystem: new Map([["m365", false]]),
    rightsBySystem: new Map([["m365", "missing" as const]]),
  }).systems[0].setup;
  assert.equal(failed.preflight, "failed");
  assert.equal(failed.test, "failed");
  assert.equal(failed.rights, "failed");
  assert.equal(failed.complete, false);

  const attested = computeClientReadiness({
    ...base,
    testBySystem: new Map([["m365", "ok" as const]]),
    preflightBySystem: new Map([["m365", true]]),
    rightsBySystem: new Map([["m365", "unverified" as const]]),
    setupBySystem: new Map([["m365", { startedAt: new Date(), attestedAt: new Date() }]]),
  }).systems[0].setup;
  assert.equal(attested.preflight, "done");
  assert.equal(attested.rights, "attested"); // unverified + operator attestation
  assert.equal(attested.complete, true);
});

test("setup vector: verified rights beat attestation; a fresh system is pending, not failed", () => {
  const verified = computeClientReadiness({
    systems: [sys("google-workspace", ["google-admin"])],
    secretExternalIds: new Map([["google-admin", "222"]]),
    testBySystem: new Map([["google-workspace", "ok"]]),
    rightsBySystem: new Map([["google-workspace", "verified" as const]]),
    setupBySystem: new Map([["google-workspace", { startedAt: null, attestedAt: new Date() }]]),
  }).systems[0].setup;
  assert.equal(verified.rights, "done");

  const fresh = computeClientReadiness({
    systems: [sys("zoom", ["zoom"])],
    secretExternalIds: new Map([["zoom", ""]]),
    testBySystem: new Map(),
  }).systems[0].setup;
  assert.equal(fresh.started, "pending");
  assert.equal(fresh.wired, "pending");
  assert.equal(fresh.test, "pending");
  assert.equal(fresh.complete, false);
});

test("setup vector: not-needed systems mark preflight/test/rights as not_needed and complete", () => {
  const v = computeClientReadiness({
    systems: [sys("1password", ["1password"])],
    secretExternalIds: new Map([["1password", NOT_NEEDED]]),
    testBySystem: new Map(),
  }).systems[0].setup;
  assert.equal(v.preflight, "not_needed");
  assert.equal(v.test, "not_needed");
  assert.equal(v.rights, "not_needed");
  assert.equal(v.complete, true);
});

// systemsReady=0 while wired>0 (wired but nothing has tested ok yet) still lands in "partial", not
// "not_set_up" (that split is keyed off systemsWired, unchanged) - but the summary must surface the
// wired count so the amber badge correlates with a visible number instead of a bare "0 of N ready".
test("partial: systemsReady 0 with systems wired reads as wired-but-untested, not a bare 0 of N", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("mimecast", ["mimecast"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["mimecast", "222"]]),
    testBySystem: new Map(), // both wired, neither tested yet
  });
  assert.equal(r.tier, "partial");
  assert.equal(r.systemsReady, 0);
  assert.equal(r.systemsWired, 2);
  assert.match(r.summary, /0 of 2 ready/);
  assert.match(r.summary, /2 wired/);
  assert.match(r.summary, /2 untested/);
});

test("partial summary names rights gaps", () => {
  const r = computeClientReadiness({
    systems: [sys("m365", ["m365-admin"]), sys("zoom", ["zoom"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["zoom", "222"]]),
    testBySystem: new Map([["m365", "ok"], ["zoom", "ok"]]),
    rightsBySystem: new Map([["zoom", "missing" as const]]),
  });
  assert.equal(r.tier, "ready"); // rights don't demote the tier (test passes) ...
  const zoom = r.systems.find((s) => s.systemKey === "zoom")!;
  assert.equal(zoom.setup.rights, "failed"); // ... but the chip shows the gap
  assert.equal(zoom.setup.complete, false);
});
