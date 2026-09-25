import { test } from "node:test";
import assert from "node:assert/strict";
import { readLaneDeps, writeLaneDeps } from "./lane-deps";

test("with no per-lane override both lanes read the shared list", () => {
  assert.deepEqual(readLaneDeps(["m365"], { onboard: { ou: "x" } }), { onboard: ["m365"], offboard: ["m365"] });
});

test("a per-lane override wins for its lane only", () => {
  assert.deepEqual(readLaneDeps(["m365"], { dependsOn: { offboard: ["exchange", "m365"] } }), { onboard: ["m365"], offboard: ["exchange", "m365"] });
});

test("identical lanes are stored exactly as before: the shared list, no override", () => {
  const out = writeLaneDeps({ onboard: ["m365", "exchange"], offboard: ["exchange", "m365"] }, { dependsOn: { offboard: ["old"] }, onboard: { ou: "x" } });
  assert.deepEqual(out, { dependsOn: ["m365", "exchange"], config: { onboard: { ou: "x" } } });
});

test("different lanes write the override, with the onboard list as the shared fallback", () => {
  const out = writeLaneDeps({ onboard: ["m365"], offboard: ["exchange"] }, { offboard: { convertToShared: true } });
  assert.deepEqual(out, { dependsOn: ["m365"], config: { offboard: { convertToShared: true }, dependsOn: { onboard: ["m365"], offboard: ["exchange"] } } });
});

test("a lane can depend on nothing while the other has dependencies", () => {
  const out = writeLaneDeps({ onboard: [], offboard: ["m365"] }, {});
  assert.deepEqual(out.config.dependsOn, { onboard: [], offboard: ["m365"] });
  // the planner reads config.dependsOn[action] ?? dependsOn, so the empty onboard list must survive
  assert.deepEqual(readLaneDeps(out.dependsOn, out.config), { onboard: [], offboard: ["m365"] });
});

test("blanks and duplicates are dropped", () => {
  assert.deepEqual(writeLaneDeps({ onboard: [" m365 ", "", "m365"], offboard: ["m365"] }, {}).dependsOn, ["m365"]);
});
