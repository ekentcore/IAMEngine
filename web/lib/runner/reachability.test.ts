import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReach, clientRunnerReachability, AGENT_ONLINE_MS, type OnlineAgentRow } from "./reachability";

const CID = "client-1";

test("cloud system: servable by a central runner", () => {
  const agents: OnlineAgentRow[] = [{ clientId: null, name: "central", capabilities: null }];
  const r = computeReach(agents, CID, ["m365"], { pinsToOwnAgent: false, clientHasOnPremAd: false });
  assert.equal(r["m365"].servable, true);
  assert.equal(r["m365"].needsOwnAgent, false);
  assert.equal(r["m365"].centralOnline, true);
});

test("on-prem AD: central runner does NOT make it servable — needs the client's own agent", () => {
  const agents: OnlineAgentRow[] = [{ clientId: null, name: "central", capabilities: null }];
  const r = computeReach(agents, CID, ["active-directory"], { pinsToOwnAgent: false, clientHasOnPremAd: true });
  assert.equal(r["active-directory"].needsOwnAgent, true);
  assert.equal(r["active-directory"].servable, false);
  assert.match(r["active-directory"].reason ?? "", /own on-prem agent/);
});

test("on-prem AD: servable when the client's own agent is online AND reports the capability", () => {
  const agents: OnlineAgentRow[] = [{ clientId: CID, name: "dc01", capabilities: '["active-directory"]' }];
  const r = computeReach(agents, CID, ["active-directory"], { pinsToOwnAgent: false, clientHasOnPremAd: true });
  assert.equal(r["active-directory"].servable, true);
  assert.equal(r["active-directory"].ownAgentOnline, true);
});

test("on-prem AD: own agent online but capability NOT reported → not servable, RSAT hint", () => {
  const agents: OnlineAgentRow[] = [{ clientId: CID, name: "dc01", capabilities: "[]" }];
  const r = computeReach(agents, CID, ["active-directory"], { pinsToOwnAgent: false, clientHasOnPremAd: true });
  assert.equal(r["active-directory"].servable, false);
  assert.match(r["active-directory"].reason ?? "", /RSAT/);
});

test("legacy agent (null capabilities) is treated as AD-capable", () => {
  const agents: OnlineAgentRow[] = [{ clientId: CID, name: "dc01", capabilities: null }];
  const r = computeReach(agents, CID, ["active-directory"], { pinsToOwnAgent: false, clientHasOnPremAd: true });
  assert.equal(r["active-directory"].servable, true);
});

test("cloud-on-own-agent pins a cloud system to the client's own agent", () => {
  const agents: OnlineAgentRow[] = [{ clientId: null, name: "central", capabilities: null }];
  const r = computeReach(agents, CID, ["m365"], { pinsToOwnAgent: true, clientHasOnPremAd: false });
  assert.equal(r["m365"].needsOwnAgent, true);
  assert.equal(r["m365"].servable, false); // only central is online, but it's pinned to own agent
});

test("clientRunnerReachability applies the 90s window and infers on-prem from the key", async () => {
  const fresh = new Date(Date.now() - 10_000);
  let capturedWhere: any;
  const db = {
    agent: {
      findMany: async (args: any) => {
        capturedWhere = args.where;
        return [{ clientId: CID, name: "dc01", capabilities: '["active-directory"]' }];
      },
    },
    client: { findUnique: async () => ({ runCloudOnOwnAgent: false }) },
  };
  const r = await clientRunnerReachability(db as any, CID, ["active-directory"]);
  // The query used the online window.
  const cutoff = capturedWhere.lastSeenAt.gt as Date;
  assert.ok(Date.now() - cutoff.getTime() >= AGENT_ONLINE_MS - 2000 && Date.now() - cutoff.getTime() <= AGENT_ONLINE_MS + 2000);
  assert.ok(fresh > cutoff); // a 10s-old heartbeat is inside the window
  assert.equal(r["active-directory"].servable, true);
});

test("clientRunnerReachability short-circuits on no systems", async () => {
  let called = false;
  const db = { agent: { findMany: async () => { called = true; return []; } }, client: { findUnique: async () => null } };
  const r = await clientRunnerReachability(db as any, CID, []);
  assert.deepEqual(r, {});
  assert.equal(called, false);
});
