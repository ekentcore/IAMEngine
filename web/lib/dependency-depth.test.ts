import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyDepth, indentStyle } from "./dependency-depth";

test("depth = longest dependency chain to a root among present items", () => {
  const d = dependencyDepth([
    { key: "servicenow", deps: [] },
    { key: "ad", deps: ["servicenow"] },
    { key: "dirsync", deps: ["ad"] },
    { key: "m365", deps: ["dirsync"] },
    { key: "mimecast", deps: ["m365"] },
    { key: "case", deps: ["m365", "mimecast"] },
  ]);
  assert.equal(d.get("servicenow"), 0);
  assert.equal(d.get("ad"), 1);
  assert.equal(d.get("dirsync"), 2);
  assert.equal(d.get("m365"), 3);
  assert.equal(d.get("mimecast"), 4);
  assert.equal(d.get("case"), 5); // longest path (via mimecast), not shortest
});

test("ignores deps not present in the list (e.g. a filtered-out lane)", () => {
  const d = dependencyDepth([{ key: "m365", deps: ["servicenow"] }]); // servicenow absent
  assert.equal(d.get("m365"), 0);
});

test("indentStyle: no indent at depth 0, scales with depth, caps at 6", () => {
  assert.deepEqual(indentStyle(0), {});
  assert.equal((indentStyle(2) as { marginLeft: string }).marginLeft, "2.2rem");
  assert.equal((indentStyle(10) as { marginLeft: string }).marginLeft, "6.6rem"); // capped at 6
});

test("roots and self-deps stay at depth 0", () => {
  const d = dependencyDepth([
    { key: "a", deps: ["a"] }, // self-dep ignored
    { key: "b", deps: [] },
  ]);
  assert.equal(d.get("a"), 0);
  assert.equal(d.get("b"), 0);
});
