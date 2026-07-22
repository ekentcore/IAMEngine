import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_STAGES, stageIndex } from "./setup-stage";

test("known stages map to their order; unknown/absent -> -1", () => {
  assert.deepEqual([...SETUP_STAGES], ["signin", "create", "harvest", "vault", "done"]);
  assert.equal(stageIndex("harvest"), 2);
  assert.equal(stageIndex("SIGNIN"), 0); // case-insensitive
  assert.equal(stageIndex(undefined), -1);
  assert.equal(stageIndex(null), -1);
  assert.equal(stageIndex("nonsense"), -1);
});
