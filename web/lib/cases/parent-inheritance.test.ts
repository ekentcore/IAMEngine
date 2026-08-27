import { test } from "node:test";
import assert from "node:assert/strict";
import { inheritsFromParent, inheritsParentModeling, applyParentInheritance } from "./parent-inheritance";

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

const BOTH = { systems: true, modeling: true };

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
  const out = applyParentInheritance(emptyChild(), parent, BOTH);
  assert.deepEqual(out.systems, parent.systems);
});

test("modeling inputs fall back INDIVIDUALLY — anything the child set still wins", () => {
  const child = { ...emptyChild(), personas: { own: {} } };
  const out = applyParentInheritance(child, parent, BOTH);
  assert.deepEqual(out.personas, { own: {} });   // child's own survives
  assert.deepEqual(out.globals, parent.globals); // unset falls back
  assert.deepEqual(out.identity, parent.identity);
});

test("a parent with no systems of its own changes nothing", () => {
  const out = applyParentInheritance(emptyChild(), { ...parent, systems: [] }, BOTH);
  assert.deepEqual(out.systems, []);
  assert.equal(out.personas, null);
});

test("a null parent changes nothing", () => {
  const child = emptyChild();
  assert.deepEqual(applyParentInheritance(child, null, BOTH), child);
});


test("modeling inheritance does NOT depend on having no systems (FR #0000041)", () => {
  // core847: five systems of its own, and its parent's four personas were unreachable.
  assert.equal(inheritsParentModeling({ parentId: "p1", inheritParentModeling: true }), true);
});

test("modeling inheritance is off when the child opted out", () => {
  assert.equal(inheritsParentModeling({ parentId: "p1", inheritParentModeling: false }), false);
});

test("a top-level client never inherits modeling", () => {
  assert.equal(inheritsParentModeling({ parentId: null, inheritParentModeling: true }), false);
});

test("modeling-only inheritance takes personas but NOT systems", () => {
  const child = { ...emptyChild(), systems: [{ systemKey: "m365" }] as unknown[] };
  const out = applyParentInheritance(child, parent, { systems: false, modeling: true });
  assert.deepEqual(out.systems, [{ systemKey: "m365" }]); // its own systems are kept
  assert.deepEqual(out.personas, parent.personas);        // the parent's personas arrive
});

test("systems-only inheritance takes systems but leaves modeling alone", () => {
  const out = applyParentInheritance(emptyChild(), parent, { systems: true, modeling: false });
  assert.deepEqual(out.systems, parent.systems);
  assert.equal(out.personas, null);
});

test("a child's OWN personas still win over the parent's", () => {
  // core860/core866 hold identical copies; they must keep using their own.
  const child = { ...emptyChild(), personas: { own: {} } };
  const out = applyParentInheritance(child, parent, BOTH);
  assert.deepEqual(out.personas, { own: {} });
});

test("an EMPTY personas object is not treated as unset", () => {
  // core2187 carries {}. Treating it as unset would hand it two personas nobody asked for.
  const child = { ...emptyChild(), personas: {} };
  const out = applyParentInheritance(child, parent, BOTH);
  assert.deepEqual(out.personas, {});
});
