import { test } from "node:test";
import assert from "node:assert/strict";
import type { Persona } from "./rules";
import { byPersonaSystemKeys, personaHasSystem, withPersonaSystem } from "./persona-systems";

const LANES = {
  "active-directory": { onboard: "by_persona", offboard: "always" },
  m365: { onboard: "always", offboard: "always" },
  xmatters: { onboard: "by_persona", offboard: "by_persona" },
};

test("byPersonaSystemKeys returns only the systems in by_persona mode for the lane", () => {
  const keys = ["active-directory", "m365", "xmatters"];
  assert.deepEqual(byPersonaSystemKeys(keys, LANES, "onboard"), ["active-directory", "xmatters"]);
  assert.deepEqual(byPersonaSystemKeys(keys, LANES, "offboard"), ["xmatters"]);
  // A key with no lane info is not treated as by_persona.
  assert.deepEqual(byPersonaSystemKeys(["unknown"], LANES, "onboard"), []);
});

test("personaHasSystem is true iff the key is present in the bundle (empty fragment counts)", () => {
  const p: Persona = { systems: { "active-directory": {}, m365: { groups: ["Staff"] } }, offboardSystems: { xmatters: {} } };
  assert.equal(personaHasSystem(p, "active-directory", "onboard"), true); // {} membership counts
  assert.equal(personaHasSystem(p, "m365", "onboard"), true);
  assert.equal(personaHasSystem(p, "xmatters", "onboard"), false); // not in onboard bundle
  assert.equal(personaHasSystem(p, "xmatters", "offboard"), true);
  assert.equal(personaHasSystem(undefined, "active-directory", "onboard"), false);
});

test("withPersonaSystem adds an empty fragment, preserves an existing one, and removes on toggle-off", () => {
  // add to an empty persona
  const added = withPersonaSystem(undefined, "active-directory", true, "onboard");
  assert.deepEqual(added.systems, { "active-directory": {} });

  // adding a system that already has config does NOT wipe it
  const withCfg: Persona = { systems: { "active-directory": { groups: ["Vets"] } } };
  const readd = withPersonaSystem(withCfg, "active-directory", true, "onboard");
  assert.deepEqual(readd.systems, { "active-directory": { groups: ["Vets"] } });

  // removing drops the key entirely, leaving siblings intact
  const two: Persona = { systems: { "active-directory": {}, m365: { groups: ["Staff"] } } };
  const removed = withPersonaSystem(two, "active-directory", false, "onboard");
  assert.deepEqual(removed.systems, { m365: { groups: ["Staff"] } });

  // offboard lane targets offboardSystems, not systems
  const off = withPersonaSystem(undefined, "xmatters", true, "offboard");
  assert.deepEqual(off.offboardSystems, { xmatters: {} });
});

test("withPersonaSystem never mutates its input", () => {
  const p: Persona = { systems: { m365: {} } };
  const next = withPersonaSystem(p, "active-directory", true, "onboard");
  assert.deepEqual(p.systems, { m365: {} }); // original untouched
  assert.notEqual(next.systems, p.systems);
});
