import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBuildIsCurrent } from "./agent-updates";

test("agentBuildIsCurrent: only a valid build-hash equal to the served build is current", () => {
  const build = "a1b2c3d4e5f6";
  assert.equal(agentBuildIsCurrent(build, build), true);
  assert.equal(agentBuildIsCurrent("a1b2c3d4e5f7", build), false); // different hash -> stale
  assert.equal(agentBuildIsCurrent(null, build), false);           // never reported
  assert.equal(agentBuildIsCurrent(undefined, build), false);
  assert.equal(agentBuildIsCurrent("1.39.0", build), false);       // legacy semver, not a hash
  assert.equal(agentBuildIsCurrent("xyz", build), false);          // non-hex
});
