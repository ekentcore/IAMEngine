import { test } from "node:test";
import assert from "node:assert/strict";
import { agentBuildIsCurrent, autoUpdateDecision, AGENT_UPDATE_MAX_ATTEMPTS } from "./agent-updates";

test("agentBuildIsCurrent: only a valid build-hash equal to the served build is current", () => {
  const build = "a1b2c3d4e5f6";
  assert.equal(agentBuildIsCurrent(build, build), true);
  assert.equal(agentBuildIsCurrent("a1b2c3d4e5f7", build), false); // different hash -> stale
  assert.equal(agentBuildIsCurrent(null, build), false);           // never reported
  assert.equal(agentBuildIsCurrent(undefined, build), false);
  assert.equal(agentBuildIsCurrent("1.39.0", build), false);       // legacy semver, not a hash
  assert.equal(agentBuildIsCurrent("xyz", build), false);          // non-hex
});

// The guard behind these: a self-update EXITS the runner process, so an agent whose pull never lands
// was being killed every 90 seconds by the app's own auto-updater until its supervisor gave up. That
// is what "the cloud runner keeps crashing and needs a manual restart" actually was.
const BUILD = "aaaaaaaaaaaa";

test("autoUpdateDecision: issues the update and counts the attempt while attempts remain", () => {
  const d = autoUpdateDecision({ attempts: 0, stalledBuild: null, build: BUILD });
  assert.equal(d.action, "update");
  assert.equal(d.attempts, 1); // the caller persists this — the count only moves when we actually ask
});

test("autoUpdateDecision: stops asking once the attempts are spent", () => {
  const last = autoUpdateDecision({ attempts: AGENT_UPDATE_MAX_ATTEMPTS - 1, stalledBuild: null, build: BUILD });
  assert.equal(last.action, "update");
  assert.equal(last.attempts, AGENT_UPDATE_MAX_ATTEMPTS);
  const spent = autoUpdateDecision({ attempts: AGENT_UPDATE_MAX_ATTEMPTS, stalledBuild: null, build: BUILD });
  assert.equal(spent.action, "stalled");
});

test("autoUpdateDecision: a NEW served build resets the count — a new bundle is a new thing to try", () => {
  const d = autoUpdateDecision({ attempts: 99, stalledBuild: "bbbbbbbbbbbb", build: BUILD });
  assert.equal(d.action, "update");
  assert.equal(d.reset, true);
  assert.equal(d.attempts, 1); // fresh set of attempts, not 100
});

test("autoUpdateDecision: stays stalled while the app still serves the build it could not reach", () => {
  const d = autoUpdateDecision({ attempts: AGENT_UPDATE_MAX_ATTEMPTS, stalledBuild: BUILD, build: BUILD });
  assert.equal(d.action, "stalled");
  assert.equal(d.reset, false);
});
