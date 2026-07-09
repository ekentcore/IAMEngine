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
    systems: [sys("m365", ["m365-admin"]), sys("mimecast", ["mimecast"]), sys("spanning", ["spanning"]), sys("active-directory", ["ad-dc"])],
    secretExternalIds: new Map([["m365-admin", "111"], ["mimecast", "222"], ["spanning", "333"], ["ad-dc", ""]]),
    testBySystem: new Map([["m365", "ok"], ["mimecast", "fail"], ["spanning", "untested"]]),
  });
  assert.equal(r.tier, "partial");
  assert.equal(r.systemsReady, 1);       // only m365 wired+ok
  assert.match(r.summary, /1 of 4 ready/);
  assert.match(r.summary, /1 missing creds/); // ad-dc
  assert.match(r.summary, /1 untested/);      // spanning
  assert.match(r.summary, /1 failing/);       // mimecast
});

test("NOT_NEEDED counts as wired (manual-step module)", () => {
  const r = computeClientReadiness({
    systems: [sys("1password", ["1password"])],
    secretExternalIds: new Map([["1password", NOT_NEEDED]]),
    testBySystem: new Map([["1password", "ok"]]),
  });
  assert.equal(r.tier, "ready");
});

test("no_systems: no credentialed systems modeled", () => {
  const r = computeClientReadiness({ systems: [], secretExternalIds: new Map(), testBySystem: new Map() });
  assert.equal(r.tier, "no_systems");
});
