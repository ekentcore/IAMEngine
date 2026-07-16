import { test } from "node:test";
import assert from "node:assert/strict";
import { planCase } from "./orchestrator";
import type { ClientSystem } from "@prisma/client";

function sys(over: Partial<ClientSystem>): ClientSystem {
  return {
    id: "id", clientId: "c", systemKey: "m365", mode: "api",
    onboardWhen: "always", offboardWhen: "always",
    dependsOn: [], requiresApproval: false, captureEvidence: false,
    secretNames: [], config: null,
    ...over,
  } as unknown as ClientSystem;
}

test("always lanes included, never lanes excluded", () => {
  const systems = [sys({ systemKey: "servicenow" }), sys({ systemKey: "x", onboardWhen: "never" })];
  const keys = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.deepEqual(keys, ["servicenow"]);
});

test("on-request 'teams' is gated by the phone-line signal", () => {
  const systems = [sys({ systemKey: "servicenow" }), sys({ systemKey: "teams", onboardWhen: "on_request" })];
  assert.ok(planCase(systems, "onboard", { officeLineRequired: true }).some((j) => j.systemKey === "teams"));
  assert.equal(planCase(systems, "onboard", {}).some((j) => j.systemKey === "teams"), false);
});

test("on-request honors a config.requestKey override", () => {
  const systems = [sys({ systemKey: "adobe", onboardWhen: "on_request", config: { requestKey: "needsAdobe" } })];
  assert.equal(planCase(systems, "onboard", { needsAdobe: true }).length, 1);
  assert.equal(planCase(systems, "onboard", {}).length, 0);
});

test("on-request falls back to a payload flag named after the system (manual cases)", () => {
  const systems = [sys({ systemKey: "zoom", onboardWhen: "on_request" })];
  assert.equal(planCase(systems, "onboard", { zoom: true }).length, 1);
  assert.equal(planCase(systems, "onboard", {}).length, 0);
});

test("by-persona lane: included only when the persona's system keys carry it", () => {
  const systems = [sys({ systemKey: "servicenow" }), sys({ systemKey: "xmatters", onboardWhen: "by_persona" })];
  assert.ok(planCase(systems, "onboard", {}, new Set(["xmatters"])).some((j) => j.systemKey === "xmatters"));
  assert.equal(planCase(systems, "onboard", {}, new Set()).some((j) => j.systemKey === "xmatters"), false);
  // No persona context at all (e.g. a caller that never resolves personas) -> excluded, never a crash.
  assert.equal(planCase(systems, "onboard", {}).some((j) => j.systemKey === "xmatters"), false);
});

test("by-persona lane ignores payload flags — only the persona set includes it", () => {
  const systems = [sys({ systemKey: "xmatters", onboardWhen: "by_persona" })];
  assert.equal(planCase(systems, "onboard", { xmatters: true }, new Set()).length, 0);
});

test("planned job config is the lane's config, not the whole blob", () => {
  const cfg = { onboard: { licenses: ["E3"] }, offboard: { blockSignIn: true }, dependsOn: {} };
  assert.deepEqual(planCase([sys({ config: cfg })], "onboard", {})[0].config, { licenses: ["E3"] });
  assert.deepEqual(planCase([sys({ config: cfg })], "offboard", {})[0].config, { blockSignIn: true });
});

test("identity flow: a mis-wired hybrid client still plans AD -> sync -> cloud (deadlock-proof)", () => {
  // The exact inversion that stalled Coretelligent: exchange as the root, AD/sync depending on cloud.
  const systems = [
    sys({ systemKey: "exchange", dependsOn: [] }),
    sys({ systemKey: "m365", dependsOn: ["exchange"] }),
    sys({ systemKey: "directory-sync", dependsOn: ["exchange"] }),
    sys({ systemKey: "active-directory", dependsOn: ["exchange", "directory-sync"] }),
  ];
  const order = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.ok(order.indexOf("active-directory") < order.indexOf("directory-sync"), `AD before sync: ${order}`);
  assert.ok(order.indexOf("directory-sync") < order.indexOf("m365"), `sync before m365: ${order}`);
  assert.ok(order.indexOf("m365") < order.indexOf("exchange"), `m365 before exchange: ${order}`);
});

test("identity flow: a cloud-native client (no AD) is left untouched", () => {
  const systems = [sys({ systemKey: "m365", dependsOn: [] }), sys({ systemKey: "exchange", dependsOn: ["m365"] })];
  const order = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.deepEqual(order, ["m365", "exchange"]);
});

test("requiresApproval/captureEvidence resolve per-lane (no cross-lane bleed)", () => {
  const cfg = { onboard: null, offboard: null, requiresApproval: { offboard: true }, captureEvidence: { offboard: true } };
  // column is the collapsed OR (true) — must NOT leak onto the onboard lane.
  const on = planCase([sys({ config: cfg, requiresApproval: true, captureEvidence: true })], "onboard", {})[0];
  assert.equal(on.requiresApproval, false);
  assert.equal(on.captureEvidence, false);
  const off = planCase([sys({ config: cfg, requiresApproval: true, captureEvidence: true })], "offboard", {})[0];
  assert.equal(off.requiresApproval, true);
  assert.equal(off.captureEvidence, true);
});

test("legacy config without per-lane flags falls back to the column", () => {
  const j = planCase([sys({ config: { onboard: {}, offboard: {} }, requiresApproval: true })], "onboard", {})[0];
  assert.equal(j.requiresApproval, true);
});

test("topological order honors dependsOn", () => {
  const systems = [sys({ systemKey: "m365", dependsOn: ["servicenow"] }), sys({ systemKey: "servicenow" })];
  const order = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.ok(order.indexOf("servicenow") < order.indexOf("m365"));
});

test("case-resolution always runs last: implicit dependency on every other system", () => {
  const systems = [
    sys({ systemKey: "case-resolution" }), // declared FIRST, no deps — would dispatch first under naive DAG
    sys({ systemKey: "m365" }),
    sys({ systemKey: "mimecast", dependsOn: ["m365"] }),
  ];
  const plan = planCase(systems, "onboard", {});
  const resolution = plan.find((j) => j.systemKey === "case-resolution")!;
  assert.equal(plan[plan.length - 1].systemKey, "case-resolution");
  assert.deepEqual([...resolution.dependsOn].sort(), ["m365", "mimecast"]);
});

test("a manual step never carries requiresApproval (approval gates only auto-running API steps)", () => {
  // sentinelone as a MANUAL checklist item with requiresApproval set: the human doing it IS the
  // approval, so it must not put the case in "needs approval".
  const manual = planCase([sys({ systemKey: "sentinelone", mode: "manual", requiresApproval: true })], "offboard", {})[0];
  assert.equal(manual.requiresApproval, false);
  // the same system as an API step keeps its approval gate
  const api = planCase([sys({ systemKey: "sentinelone", mode: "api", requiresApproval: true })], "offboard", {})[0];
  assert.equal(api.requiresApproval, true);
});

// ── Offboard intent (disable / destructive) ──────────────────────────────────────────────────────
test("offboard steps default to intent 'disable'; onboard is unclassified (null)", () => {
  const s = [sys({ systemKey: "active-directory" })];
  assert.equal(planCase(s, "offboard", {})[0].intent, "disable");
  assert.equal(planCase(s, "onboard", {})[0].intent, null);
});

test("destructive offboard forces requiresApproval + captureEvidence", () => {
  const s = [sys({ systemKey: "m365", requiresApproval: false, captureEvidence: false, config: { intent: { offboard: "destructive" } } })];
  const j = planCase(s, "offboard", {})[0];
  assert.equal(j.intent, "destructive");
  assert.equal(j.requiresApproval, true);  // forced on
  assert.equal(j.captureEvidence, true);   // forced on (snapshot before delete)
});

test("a destructive flag on the OFFBOARD lane does not gate the ONBOARD lane", () => {
  const s = [sys({ systemKey: "m365", config: { intent: { offboard: "destructive" } } })];
  const j = planCase(s, "onboard", {})[0];
  assert.equal(j.intent, null);
  assert.equal(j.requiresApproval, false);
});

test("a manual destructive step never requires approval (the human doing it IS the approval)", () => {
  const s = [sys({ systemKey: "fileserver", mode: "manual", config: { intent: { offboard: "destructive" } } })];
  const j = planCase(s, "offboard", {})[0];
  assert.equal(j.intent, "destructive");
  assert.equal(j.requiresApproval, false);
  assert.equal(j.captureEvidence, true); // evidence still captured
});

// ── AD email write-back (mail attribute) ─────────────────────────────────────────────────────────
test("AD onboard injects ad-email-writeback after the cloud steps", () => {
  const systems = [
    sys({ systemKey: "active-directory", dependsOn: [] }),
    sys({ systemKey: "directory-sync", dependsOn: ["active-directory"] }),
    sys({ systemKey: "m365", dependsOn: ["directory-sync"] }),
    sys({ systemKey: "exchange", dependsOn: ["m365"] }),
  ];
  const jobs = planCase(systems, "onboard", {});
  const wb = jobs.find((j) => j.systemKey === "ad-email-writeback");
  assert.ok(wb, "write-back step is injected");
  assert.equal(wb!.mode, "api");
  assert.deepEqual(wb!.secretNames, [], "ad-dc is optional — unwired here, so no required secret (runs ambient)");
  assert.equal(wb!.requiresApproval, false);
  const seq = (k: string) => jobs.find((j) => j.systemKey === k)!.sequence;
  assert.ok(seq("ad-email-writeback") > seq("m365"), "after m365");
  assert.ok(seq("ad-email-writeback") > seq("exchange"), "after exchange");
});

test("write-back is onboard-only and AD-only", () => {
  const ad = [sys({ systemKey: "active-directory" }), sys({ systemKey: "m365", dependsOn: ["active-directory"] })];
  assert.equal(planCase(ad, "offboard", {}).some((j) => j.systemKey === "ad-email-writeback"), false); // offboard: none
  const cloud = [sys({ systemKey: "m365" }), sys({ systemKey: "exchange", dependsOn: ["m365"] })];
  assert.equal(planCase(cloud, "onboard", {}).some((j) => j.systemKey === "ad-email-writeback"), false); // no AD: none
  const adOnly = [sys({ systemKey: "active-directory" }), sys({ systemKey: "directory-sync", dependsOn: ["active-directory"] })];
  assert.equal(planCase(adOnly, "onboard", {}).some((j) => j.systemKey === "ad-email-writeback"), false); // no cloud consumer: none
});

// ── Hybrid identity-link check (ad-consistency-check) ────────────────────────────────────────────
test("AD onboard injects ad-consistency-check after the cloud step", () => {
  const systems = [
    sys({ systemKey: "active-directory" }),
    sys({ systemKey: "directory-sync", dependsOn: ["active-directory"] }),
    sys({ systemKey: "m365", dependsOn: ["directory-sync"] }),
  ];
  const jobs = planCase(systems, "onboard", {});
  const chk = jobs.find((j) => j.systemKey === "ad-consistency-check");
  assert.ok(chk, "check step injected for a hybrid onboard");
  assert.equal(chk!.requiresApproval, false); // detect-only, never gates
  assert.deepEqual(chk!.secretNames, [], "ad-dc is optional — unwired here (runs ambient)");
  const seq = (k: string) => jobs.find((j) => j.systemKey === k)!.sequence;
  assert.ok(seq("ad-consistency-check") > seq("m365"), "runs after m365");
  // runs after the write-back too (both touch AD post-sync)
  assert.ok(seq("ad-consistency-check") > seq("ad-email-writeback"));
});

test("ad-consistency-check is onboard-only and needs AD + cloud", () => {
  const ad = [sys({ systemKey: "active-directory" }), sys({ systemKey: "m365", dependsOn: ["active-directory"] })];
  assert.equal(planCase(ad, "offboard", {}).some((j) => j.systemKey === "ad-consistency-check"), false);
  const cloud = [sys({ systemKey: "m365" })];
  assert.equal(planCase(cloud, "onboard", {}).some((j) => j.systemKey === "ad-consistency-check"), false);
  const adOnly = [sys({ systemKey: "active-directory" }), sys({ systemKey: "directory-sync", dependsOn: ["active-directory"] })];
  assert.equal(planCase(adOnly, "onboard", {}).some((j) => j.systemKey === "ad-consistency-check"), false);
});

test("a system whose every secret is 'not needed' plans as a manual step, not a failing api job", () => {
  const systems = [
    sys({ systemKey: "duo", secretNames: ["duo"], offboardWhen: "always" }),
    sys({ systemKey: "zoom", secretNames: ["zoom"], offboardWhen: "always" }),
  ];
  const jobs = planCase(systems, "offboard", {}, undefined, new Set(["duo"]));
  const duo = jobs.find((j) => j.systemKey === "duo")!;
  const zoom = jobs.find((j) => j.systemKey === "zoom")!;
  assert.equal(duo.mode, "manual", "no credential to broker → a human does it");
  assert.equal(zoom.mode, "api", "a wired secret still runs automatically");
});

test("a 'not needed' step never gates the case on approval", () => {
  const systems = [sys({ systemKey: "sentinelone", secretNames: ["sentinelone"], offboardWhen: "always", requiresApproval: true })];
  const jobs = planCase(systems, "offboard", {}, undefined, new Set(["sentinelone"]));
  assert.equal(jobs[0].mode, "manual");
  assert.equal(jobs[0].requiresApproval, false, "doing the manual step IS the approval");
});

test("a system with a mix of wired and not-needed secrets still runs as api", () => {
  const systems = [sys({ systemKey: "exchange", secretNames: ["exchange-onprem", "m365-admin"], offboardWhen: "always" })];
  const jobs = planCase(systems, "offboard", {}, undefined, new Set(["exchange-onprem"]));
  assert.equal(jobs[0].mode, "api", "one real credential is enough to automate");
});

test("a system with no secrets at all is unaffected by the not-needed rule", () => {
  const systems = [sys({ systemKey: "case-resolution", mode: "api", secretNames: [], offboardWhen: "always" })];
  assert.equal(planCase(systems, "offboard", {}, undefined, new Set(["duo"]))[0].mode, "api");
});


// REGRESSION: `spanning-portal` must NOT be attached to the Spanning licensing lanes. Every name in a
// job's secretNames is REQUIRED — the claim gate skips a job with an unreferenced secret and the runner
// brokers each name unconditionally — so appending an optional, mostly-unwired secret here would have
// made Spanning licensing UNCLAIMABLE for the whole fleet. It belongs only on the force-sync job, and
// only when the client has wired it (see lib/secrets/auxiliary.ts).
test("spanning licensing jobs carry only the API secret — never the optional portal login", () => {
  for (const action of ["onboard", "offboard"] as const) {
    const jobs = planCase([sys({ systemKey: "spanning", secretNames: ["spanning"] })], action, {});
    assert.deepEqual(jobs[0].secretNames, ["spanning"]);
  }
});

// ad-dc is OPTIONAL for Active Directory: on a domain controller the runner authenticates as ambient
// SYSTEM (PR #69) and needs no credential. So a client that hasn't wired ad-dc must still get an API
// job (never brokered ad-dc up-front, never demoted to a manual step), while a client that HAS wired
// it (a member-server agent that genuinely needs it) still carries it so the runner brokers the fallback.
const AD = { systemKey: "active-directory", secretNames: ["ad-dc"], offboardWhen: "always" as const };

test("ad-dc unwired: the AD job runs api with NO required secret (ambient SYSTEM)", () => {
  const jobs = planCase([sys(AD)], "onboard", {});
  assert.deepEqual(jobs[0].secretNames, [], "ad-dc must not be a required secret when unwired");
  assert.equal(jobs[0].mode, "api", "AD still automates — it does not fall back to a manual step");
});

test("ad-dc marked not-needed: AD stays api and is NOT demoted to manual", () => {
  // This is the exact regression: marking ad-dc 'not needed' used to force AD to a manual step.
  const jobs = planCase([sys(AD)], "onboard", {}, undefined, new Set(["ad-dc"]));
  assert.equal(jobs[0].mode, "api", "an optional not-needed secret must not demote the system to manual");
  assert.deepEqual(jobs[0].secretNames, []);
});

test("ad-dc wired: the AD job carries it so the runner brokers the fallback (member server)", () => {
  const jobs = planCase([sys(AD)], "onboard", {}, undefined, undefined, new Set(["ad-dc"]));
  assert.deepEqual(jobs[0].secretNames, ["ad-dc"], "a wired ad-dc is attached for the member-server case");
  assert.equal(jobs[0].mode, "api");
});

test("directory-sync gets the same optional-ad-dc treatment", () => {
  const dirsync = { systemKey: "directory-sync", secretNames: ["ad-dc"], offboardWhen: "always" as const };
  assert.deepEqual(planCase([sys(dirsync)], "offboard", {})[0].secretNames, []);
  assert.deepEqual(planCase([sys(dirsync)], "offboard", {}, undefined, undefined, new Set(["ad-dc"]))[0].secretNames, ["ad-dc"]);
});

test("a required (non-optional) not-needed secret STILL demotes to manual — unchanged", () => {
  // Guard: making ad-dc optional must not weaken the manual-step rule for genuinely required secrets.
  const jobs = planCase([sys({ systemKey: "adobe", secretNames: ["adobe"], offboardWhen: "always" })], "offboard", {}, undefined, new Set(["adobe"]));
  assert.equal(jobs[0].mode, "manual");
});

// --- offboard ordering: the mailbox convert must precede licence removal ------------------------
// Regression guards for the billable-seat leak seen on UM0029796 (Apollon Wealth). The identity
// pipeline is an ONBOARD chain (create in AD -> sync -> cloud consumers, exchange last). Run on an
// offboard it put `exchange` after entra/m365, so the licence step correctly refused to strip a
// licence off an unconverted mailbox, warned "re-run once the mailbox step is done", and nothing
// ever re-ran it. The seat stayed assigned forever.

const adPipeline = () => [
  sys({ systemKey: "active-directory" }),
  sys({ systemKey: "directory-sync", dependsOn: ["active-directory"] }),
  sys({ systemKey: "entra" }),
  sys({ systemKey: "m365", dependsOn: ["directory-sync"] }),
  // Inherited from the onboard lane, where a mailbox genuinely needs its licence first.
  sys({ systemKey: "exchange", dependsOn: ["m365"] }),
];

test("offboard: exchange converts the mailbox BEFORE entra/m365 take the licence off", () => {
  const keys = planCase(adPipeline(), "offboard", {}).map((j) => j.systemKey);
  assert.ok(keys.indexOf("exchange") < keys.indexOf("entra"), `exchange must precede entra: ${keys}`);
  assert.ok(keys.indexOf("exchange") < keys.indexOf("m365"), `exchange must precede m365: ${keys}`);
  // ...and the on-prem origin invariant still holds.
  assert.ok(keys.indexOf("active-directory") < keys.indexOf("directory-sync"));
  assert.ok(keys.indexOf("directory-sync") < keys.indexOf("exchange"));
});

test("onboard is unchanged: create in AD, sync, then the cloud consumers with exchange last", () => {
  // (an AD onboard also appends the injected ad-email-writeback / ad-consistency-check steps)
  const keys = planCase(adPipeline(), "onboard", {})
    .map((j) => j.systemKey)
    .filter((k) => ["active-directory", "directory-sync", "entra", "m365", "exchange"].includes(k));
  assert.deepEqual(keys, ["active-directory", "directory-sync", "entra", "m365", "exchange"]);
});

test("offboard: entra/m365 depend on exchange, and exchange never depends on them (no cycle)", () => {
  const jobs = planCase(adPipeline(), "offboard", {});
  const dep = (k: string) => jobs.find((j) => j.systemKey === k)!.dependsOn;
  assert.ok(dep("entra").includes("exchange"));
  assert.ok(dep("m365").includes("exchange"));
  assert.equal(dep("exchange").some((d) => d === "entra" || d === "m365"), false);
});

test("offboard: a cloud-only client's declared 'exchange dependsOn m365' is reordered too", () => {
  // The ~200 seeded clients carry this ordering in the DB, where a profile edit can't reach them.
  const systems = [sys({ systemKey: "m365" }), sys({ systemKey: "exchange", dependsOn: ["m365"] })];
  const keys = planCase(systems, "offboard", {}).map((j) => j.systemKey);
  assert.deepEqual(keys, ["exchange", "m365"]);
  // The same profile onboards in the original order — a mailbox needs its licence first.
  assert.deepEqual(planCase(systems, "onboard", {}).map((j) => j.systemKey), ["m365", "exchange"]);
});

test("ad-standalone (an AD system but no directory-sync): the pipeline rewrite does not fire", () => {
  // regal: AD runs file/print, 365 is provisioned separately with no sync — its profile says so
  // outright. Keying the invariant on the AD system alone reversed its declared entra/m365 order and
  // gated an entire cloud offboard behind an AD step the profile explicitly disclaims.
  const systems = [
    sys({ systemKey: "active-directory" }),
    sys({ systemKey: "m365" }),
    sys({ systemKey: "entra", dependsOn: ["m365"] }),
  ];
  const jobs = planCase(systems, "onboard", {});
  const dep = (k: string) => jobs.find((j) => j.systemKey === k)!.dependsOn;
  assert.deepEqual(dep("entra"), ["m365"]); // declared order preserved, not reversed
  assert.deepEqual(dep("m365"), []); // not gated behind AD
});

test("offboard with no exchange system in the plan is unaffected", () => {
  const systems = [sys({ systemKey: "m365" }), sys({ systemKey: "entra", dependsOn: ["m365"] })];
  const jobs = planCase(systems, "offboard", {});
  assert.deepEqual(jobs.find((j) => j.systemKey === "entra")!.dependsOn, ["m365"]);
});
