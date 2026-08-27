import { test } from "node:test";
import assert from "node:assert/strict";
import { inheritsFromParent, applyParentInheritance } from "./parent-inheritance";

const parent = {
  systems: [{ systemKey: "m365" }, { systemKey: "exchange" }] as unknown[],
  identity: { usernamePatterns: ["{first}.{last}@{domain}"] },
  personas: { vet: {} }, globals: { m365: {} }, globalsOffboard: { m365: {} },
  locations: { rows: [] }, adObjects: { ous: [] }, cloudGroups: { groups: [] },
};

const emptyChild = () => ({
  systems: [] as unknown[], identity: null, personas: null, globals: null,
  globalsOffboard: null, locations: null, adObjects: null, cloudGroups: null,
});

test("a child with no systems, a parent, and inheritance on DOES inherit", () => {
  assert.equal(inheritsFromParent({ systems: [], parentId: "p1", inheritParentSystems: true }), true);
});

test("a child with its own systems does NOT inherit (adding systems ends inheritance)", () => {
  assert.equal(inheritsFromParent({ systems: [{ systemKey: "m365" }], parentId: "p1", inheritParentSystems: true }), false);
});

test("a child with inheritance switched off does NOT inherit", () => {
  assert.equal(inheritsFromParent({ systems: [], parentId: "p1", inheritParentSystems: false }), false);
});

test("a top-level client never inherits", () => {
  assert.equal(inheritsFromParent({ systems: [], parentId: null, inheritParentSystems: true }), false);
});

test("systems come wholesale from the parent", () => {
  const out = applyParentInheritance(emptyChild(), parent);
  assert.deepEqual(out.systems, parent.systems);
});

test("modeling inputs fall back INDIVIDUALLY — anything the child set still wins", () => {
  const child = { ...emptyChild(), personas: { own: {} } };
  const out = applyParentInheritance(child, parent);
  assert.deepEqual(out.personas, { own: {} });   // child's own survives
  assert.deepEqual(out.globals, parent.globals); // unset falls back
  assert.deepEqual(out.identity, parent.identity);
});

test("a parent with no systems of its own changes nothing", () => {
  const out = applyParentInheritance(emptyChild(), { ...parent, systems: [] });
  assert.deepEqual(out.systems, []);
  assert.equal(out.personas, null);
});

test("a null parent changes nothing", () => {
  const child = emptyChild();
  assert.deepEqual(applyParentInheritance(child, null), child);
});
