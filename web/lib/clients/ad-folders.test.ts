import { test } from "node:test";
import assert from "node:assert/strict";
import { folderLabel, folderKind, parentDn, buildTree, withOnboardOu } from "./ad-folders";

test("folderLabel: OU node shows the OU name", () => {
  assert.equal(folderLabel("OU=Employees,DC=ad,DC=x,DC=com"), "Employees");
});

test("folderLabel: CN container shows the container name", () => {
  assert.equal(folderLabel("CN=Users,DC=ad,DC=x,DC=com"), "Users");
});

test("folderLabel: nested OU shows only its own leaf name", () => {
  assert.equal(folderLabel("OU=Terminated,OU=Employees,DC=ad,DC=x,DC=com"), "Terminated");
});

test("folderLabel: domain root renders as the dotted domain", () => {
  assert.equal(folderLabel("DC=ad,DC=puretechscientific,DC=com"), "ad.puretechscientific.com");
});

test("folderLabel: unparseable input returns the raw string", () => {
  assert.equal(folderLabel("not-a-dn"), "not-a-dn");
});

test("folderKind: distinguishes OU, container and domain root", () => {
  assert.equal(folderKind("OU=Employees,DC=x,DC=com"), "ou");
  assert.equal(folderKind("CN=Users,DC=x,DC=com"), "container");
  assert.equal(folderKind("DC=x,DC=com"), "domain");
});

test("parentDn: strips the leftmost RDN", () => {
  assert.equal(parentDn("OU=Terminated,OU=Employees,DC=x,DC=com"), "OU=Employees,DC=x,DC=com");
  assert.equal(parentDn("CN=Users,DC=x,DC=com"), "DC=x,DC=com");
  assert.equal(parentDn("DC=com"), "");
});

test("buildTree: containers and OUs nest under the domain root as a single tree", () => {
  const root = "DC=ad,DC=x,DC=com";
  const dns = [
    root,
    "CN=Users,DC=ad,DC=x,DC=com",
    "OU=Employees,DC=ad,DC=x,DC=com",
    "OU=Terminated,OU=Employees,DC=ad,DC=x,DC=com",
  ];
  const { roots, children } = buildTree(dns);
  assert.deepEqual(roots, [root]); // single connected tree
  const rootKids = children.get(root) ?? [];
  assert.ok(rootKids.includes("CN=Users,DC=ad,DC=x,DC=com"));
  assert.ok(rootKids.includes("OU=Employees,DC=ad,DC=x,DC=com"));
  assert.deepEqual(children.get("OU=Employees,DC=ad,DC=x,DC=com"), [
    "OU=Terminated,OU=Employees,DC=ad,DC=x,DC=com",
  ]);
});

test("buildTree: when the root isn't discovered, top-level folders become roots", () => {
  const dns = ["OU=A,DC=x,DC=com", "OU=B,DC=x,DC=com"];
  const { roots } = buildTree(dns);
  assert.deepEqual(roots.sort(), ["OU=A,DC=x,DC=com", "OU=B,DC=x,DC=com"]);
});

test("withOnboardOu: sets onboard.ou on an empty config", () => {
  assert.deepEqual(withOnboardOu({}, "CN=Users,DC=x,DC=com"), {
    onboard: { ou: "CN=Users,DC=x,DC=com" },
  });
});

test("withOnboardOu: preserves other onboard keys and sibling lanes", () => {
  const out = withOnboardOu(
    { onboard: { ou: "OU=Old,DC=x", writeback: true }, offboard: { delete: true } },
    "CN=Users,DC=x,DC=com",
  );
  assert.deepEqual(out, {
    onboard: { ou: "CN=Users,DC=x,DC=com", writeback: true },
    offboard: { delete: true },
  });
});

test("withOnboardOu: empty value removes the ou key without dropping other onboard settings", () => {
  assert.deepEqual(withOnboardOu({ onboard: { ou: "OU=Old,DC=x", writeback: true } }, ""), {
    onboard: { writeback: true },
  });
});

test("withOnboardOu: does not mutate the input config", () => {
  const input = { onboard: { ou: "OU=Old,DC=x" } };
  withOnboardOu(input, "CN=Users,DC=x,DC=com");
  assert.equal(input.onboard.ou, "OU=Old,DC=x");
});
