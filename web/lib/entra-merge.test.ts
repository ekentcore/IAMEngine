import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientSystem } from "@prisma/client";
import { mergeEntraIntoM365 } from "./entra-merge";
import { planCase } from "./orchestrator";

function sys(over: Partial<ClientSystem>): ClientSystem {
  return {
    id: "id", clientId: "c", systemKey: "m365", mode: "api", onboardWhen: "always", offboardWhen: "always",
    dependsOn: [], requiresApproval: false, captureEvidence: false, secretNames: ["m365-admin"], config: null, ...over,
  } as unknown as ClientSystem;
}

test("MarketScience: the licence m365 deferred to entra is removed by the merged step", () => {
  const out = mergeEntraIntoM365([
    sys({ systemKey: "m365", config: { offboard: { blockSignIn: true, removeAllGroups: true, removeLicense: { defer: true, removedBy: "entra", note: "not here" } } } }),
    sys({ systemKey: "entra", dependsOn: ["exchange", "m365"], config: { offboard: { removeAppAccess: true, revokeActiveSessions: true, removeLicense: true } } }),
    sys({ systemKey: "exchange" }),
  ]);
  const m = out.find((s) => s.systemKey === "m365")!;
  assert.equal(out.some((s) => s.systemKey === "entra"), false);
  assert.deepEqual((m.config as { offboard: unknown }).offboard, { removeAppAccess: true, revokeActiveSessions: true, removeLicense: true, blockSignIn: true, removeAllGroups: true });
  assert.deepEqual(m.dependsOn, ["exchange"]); // entra's deps carried, minus the pair itself
});

test("Yuma: complementary lane keys are unioned, m365 wins a conflict", () => {
  const out = mergeEntraIntoM365([
    sys({ systemKey: "m365", config: { offboard: { blockSignIn: true, removeAllGroups: true, removeLicense: true } } }),
    sys({ systemKey: "entra", config: { offboard: { disableAccount: true, removeAllGroups: false, revokeMfaSessions: true, resetPassword: { captureForDeliveryInM365Step: true } } } }),
  ]);
  assert.deepEqual((out[0].config as { offboard: unknown }).offboard, {
    disableAccount: true, removeAllGroups: true, revokeMfaSessions: true, resetPassword: { captureForDeliveryInM365Step: true }, blockSignIn: true, removeLicense: true,
  });
});

test("approval, evidence and destructive intent survive if either side had them", () => {
  const [m] = mergeEntraIntoM365([
    sys({ systemKey: "m365", config: { intent: { offboard: "disable" } } }),
    sys({ systemKey: "entra", requiresApproval: true, captureEvidence: true, secretNames: ["entra-extra"], config: { intent: { offboard: "destructive" }, requiresApproval: { offboard: true } } }),
  ]);
  assert.equal(m.requiresApproval, true);
  assert.equal(m.captureEvidence, true);
  assert.deepEqual(m.secretNames, ["m365-admin", "entra-extra"]);
  assert.equal((m.config as { intent: { offboard: string } }).intent.offboard, "destructive");
  assert.deepEqual((m.config as { requiresApproval: unknown }).requiresApproval, { onboard: false, offboard: true });
});

test("a step that waited on entra now waits on m365 (shared and per-lane deps)", () => {
  const out = mergeEntraIntoM365([
    sys({ systemKey: "m365" }), sys({ systemKey: "entra" }),
    sys({ systemKey: "notify", dependsOn: ["entra", "exchange"], config: { dependsOn: { offboard: ["entra"] } } }),
  ]);
  const n = out.find((s) => s.systemKey === "notify")!;
  assert.deepEqual(n.dependsOn, ["m365", "exchange"]);
  assert.deepEqual((n.config as { dependsOn: unknown }).dependsOn, { offboard: ["m365"] });
});

test("entra alone, or m365 alone, is left exactly as it was", () => {
  const onlyEntra = [sys({ systemKey: "entra" })];
  assert.equal(mergeEntraIntoM365(onlyEntra), onlyEntra);
  const onlyM365 = [sys({ systemKey: "m365" })];
  assert.equal(mergeEntraIntoM365(onlyM365), onlyM365);
});

test("only systems in THIS lane merge: entra offboard-only doesn't touch an m365 onboard", () => {
  const systems = [sys({ systemKey: "m365" }), sys({ systemKey: "entra", onboardWhen: "never" })];
  assert.deepEqual(planCase(systems, "onboard", {}).map((j) => j.systemKey), ["m365"]);
  const off = planCase(systems, "offboard", {});
  assert.deepEqual(off.map((j) => j.systemKey), ["m365"]);
});

// ---- review fixes ----

test("onboard: entra depending on exchange (which depends on m365) doesn't make a cycle", () => {
  // MarketScience's dependency shape, on a lane where entra is active.
  const systems = [
    sys({ systemKey: "servicenow", mode: "manual", secretNames: [] }),
    sys({ systemKey: "m365", dependsOn: ["servicenow"] }),
    sys({ systemKey: "exchange", dependsOn: ["m365"] }),
    sys({ systemKey: "entra", dependsOn: ["exchange", "m365"] }),
  ];
  const jobs = planCase(systems, "onboard", {});
  assert.deepEqual(jobs.map((j) => j.systemKey), ["servicenow", "m365", "exchange"]);
  assert.deepEqual(jobs.find((j) => j.systemKey === "m365")!.dependsOn, ["servicenow"]);
  // ...and the offboard of the same shape still converts the mailbox first.
  const off = planCase(systems, "offboard", {}).map((j) => j.systemKey);
  assert.ok(off.indexOf("exchange") < off.indexOf("m365"), `${off}`);
});

test("a column approval/evidence flag (no per-lane map) survives a merge with a side that has the map", () => {
  const jobs = planCase([
    sys({ systemKey: "m365", config: { requiresApproval: { onboard: false, offboard: false }, captureEvidence: { onboard: false, offboard: false } } }),
    sys({ systemKey: "entra", requiresApproval: true, captureEvidence: true, config: null }), // a systems-editor row
  ], "offboard", {});
  assert.equal(jobs[0].requiresApproval, true);
  assert.equal(jobs[0].captureEvidence, true);
});

test("a per-lane dependsOn on one side is unioned with the other side's shared deps", () => {
  const jobs = planCase([
    sys({ systemKey: "servicenow", mode: "manual", secretNames: [] }),
    sys({ systemKey: "mimecast" }),
    sys({ systemKey: "m365", dependsOn: ["servicenow"] }),
    sys({ systemKey: "entra", config: { dependsOn: { offboard: ["mimecast"] } } }),
  ], "offboard", {});
  assert.deepEqual([...jobs.find((j) => j.systemKey === "m365")!.dependsOn].sort(), ["mimecast", "servicenow"]);
});

test("modes differ: entra and m365 stay two steps, each with its own mode, config and deps", () => {
  // m365 manual on purpose (a human strips licence + groups); merging it into an automated entra step
  // would run that whole lane with nothing gating it.
  const systems = [
    sys({ systemKey: "servicenow", mode: "manual", secretNames: [] }),
    sys({ systemKey: "m365", mode: "manual", dependsOn: ["servicenow"], config: { offboard: { removeLicense: true, removeAllGroups: true } } }),
    sys({ systemKey: "entra", mode: "api", dependsOn: ["m365"], config: { offboard: { revokeActiveSessions: true } } }),
  ];
  assert.equal(mergeEntraIntoM365(systems), systems);
  const jobs = planCase(systems, "offboard", {});
  const job = (k: string) => jobs.find((j) => j.systemKey === k)!;
  assert.deepEqual(jobs.map((j) => j.systemKey), ["servicenow", "m365", "entra"]);
  assert.equal(job("m365").mode, "manual");
  assert.equal(job("entra").mode, "api");
  assert.deepEqual(job("m365").config, { removeLicense: true, removeAllGroups: true });
  assert.deepEqual(job("entra").dependsOn, ["m365"]);
  // Same mode: merged, as before.
  const [m] = mergeEntraIntoM365([sys({ systemKey: "m365", mode: "manual" }), sys({ systemKey: "entra", mode: "manual" })]);
  assert.equal(m.mode, "manual");
});

test("onboard: m365 -> exchange -> entra (acyclic) doesn't become a cycle once merged", () => {
  const systems = [
    sys({ systemKey: "entra" }),
    sys({ systemKey: "exchange", dependsOn: ["entra"] }),
    sys({ systemKey: "m365", dependsOn: ["exchange"] }),
  ];
  const jobs = planCase(systems, "onboard", {});
  assert.deepEqual(jobs.map((j) => j.systemKey), ["m365", "exchange"]);
});

test("property: any acyclic m365/entra graph plans without a cycle once merged", () => {
  // Deterministic PRNG; random DAGs over the pair plus four others, edges only "backwards" in a random
  // order (so the input is acyclic), with some shared and some per-lane deps.
  let seed = 117;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const keys = ["m365", "entra", "a", "b", "c", "d"];
  for (let n = 0; n < 400; n++) {
    const order = [...keys].sort(() => rnd() - 0.5);
    const earlier = (i: number) => order.slice(0, i).filter(() => rnd() < 0.4);
    const systems = order.map((k, i) => {
      const lane = rnd() < 0.3 ? { dependsOn: { onboard: earlier(i), offboard: earlier(i) } } : null;
      return sys({ systemKey: k, dependsOn: earlier(i), config: lane });
    });
    for (const action of ["onboard", "offboard"] as const) {
      assert.doesNotThrow(() => planCase(systems, action, {}), `${action}: ${JSON.stringify(systems.map((s) => [s.systemKey, s.dependsOn, s.config]))}`);
    }
  }
});

test("a licence deferral onto entra (or m365) on EITHER side means the merged step removes it", () => {
  const lic = (m: object, e: object) => {
    const [s] = mergeEntraIntoM365([
      sys({ systemKey: "m365", config: { offboard: m } as ClientSystem["config"] }),
      sys({ systemKey: "entra", config: { offboard: e } as ClientSystem["config"] }),
    ]);
    return (s.config as { offboard: { removeLicense?: unknown } }).offboard.removeLicense;
  };
  const toEntra = { defer: true, removedBy: "entra" };
  assert.equal(lic({ blockSignIn: true }, { removeLicense: toEntra }), true);
  assert.equal(lic({ removeLicense: toEntra }, { removeLicense: toEntra }), true);
  assert.equal(lic({ removeLicense: { defer: true, removedBy: "m365" } }, { revokeActiveSessions: true }), true);
  // A real removal on the other side is kept over the deferral.
  assert.deepEqual(lic({ removeLicense: { skus: ["E5"] } }, { removeLicense: toEntra }), { skus: ["E5"] });
  // A deferral to some OTHER step (e.g. an AD licensing group) is left alone.
  assert.deepEqual(lic({ removeLicense: { defer: true, removedBy: "active-directory" } }, {}), { defer: true, removedBy: "active-directory" });
});
