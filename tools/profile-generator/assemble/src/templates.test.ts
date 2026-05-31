import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "./templates.js";

test("deepMerge merges nested objects", () => {
  const out = deepMerge({ client: { id: "x", name: "X" } } as any, { client: { pod: "POD-CVP" } });
  assert.deepEqual(out, { client: { id: "x", name: "X", pod: "POD-CVP" } });
});

test("deepMerge: arrays and scalars from overlay replace base", () => {
  const out = deepMerge({ a: [1, 2], b: 1 } as any, { a: [9], b: 2 });
  assert.deepEqual(out, { a: [9], b: 2 });
});

test("deepMerge does not mutate base", () => {
  const base = { client: { id: "x" } } as any;
  deepMerge(base, { client: { pod: "P" } });
  assert.equal(base.client.pod, undefined);
});
