import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupSteps } from "./setup-steps";
import { computeClientReadiness } from "./readiness";
import { NOT_NEEDED } from "../cases/case-secrets";
import type { SecretRow } from "../secrets/wiring";

const row = (name: string, externalId: string, referencedBy: string[]): SecretRow => ({
  name,
  externalId,
  label: null,
  provider: "delinea",
  referencedBy,
  isSet: externalId !== "" && externalId !== "REPLACE_ME" && externalId !== NOT_NEEDED,
});

const readiness = (systems: { systemKey: string; secretNames: string[] }[], ids: Record<string, string>, tests: Record<string, "ok" | "fail" | "untested">) =>
  computeClientReadiness({
    systems,
    secretExternalIds: new Map(Object.entries(ids)),
    testBySystem: new Map(Object.entries(tests)),
  });

test("orders core-identity credentials before apps/security", () => {
  const rows = [row("sentinelone", "", ["sentinelone"]), row("m365-admin", "", ["m365"]), row("mimecast", "", ["mimecast"])];
  const r = readiness(
    [{ systemKey: "sentinelone", secretNames: ["sentinelone"] }, { systemKey: "m365", secretNames: ["m365-admin"] }, { systemKey: "mimecast", secretNames: ["mimecast"] }],
    {},
    {}
  );
  const steps = buildSetupSteps(rows, r);
  assert.deepEqual(steps.map((s) => s.secretName), ["m365-admin", "mimecast", "sentinelone"]);
});

test("a shared secret is one step, ready only when every referencing system tests ok", () => {
  const rows = [row("m365-admin", "111", ["m365", "exchange"])];
  const r = readiness(
    [{ systemKey: "m365", secretNames: ["m365-admin"] }, { systemKey: "exchange", secretNames: ["m365-admin"] }],
    { "m365-admin": "111" },
    { m365: "ok", exchange: "untested" }
  );
  const steps = buildSetupSteps(rows, r);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].wired, true);
  assert.equal(steps[0].ready, false); // exchange still untested
  assert.deepEqual(steps[0].systemKeys.sort(), ["exchange", "m365"]);
});

test("wired + tested ok reads ready; carries field requirements + help", () => {
  const rows = [row("m365-admin", "111", ["m365"])];
  const r = readiness([{ systemKey: "m365", secretNames: ["m365-admin"] }], { "m365-admin": "111" }, { m365: "ok" });
  const steps = buildSetupSteps(rows, r);
  assert.equal(steps[0].ready, true);
  assert.ok(steps[0].fieldRequirements.length > 0);
  assert.ok(steps[0].help && steps[0].help.href.startsWith("/help/"));
});

test("NOT_NEEDED reads as a ready manual step", () => {
  const rows = [row("mimecast", NOT_NEEDED, ["mimecast"])];
  const r = readiness([{ systemKey: "mimecast", secretNames: ["mimecast"] }], { mimecast: NOT_NEEDED }, {});
  const steps = buildSetupSteps(rows, r);
  assert.equal(steps[0].notNeeded, true);
  assert.equal(steps[0].test, "not_needed");
  assert.equal(steps[0].ready, true);
});

// REGRESSION: an OPTIONAL credential (spanning-portal — it only unlocks Spanning's force-sync) must not
// count against setup. It is deliberately absent from ClientSystem.secretNames, so `refSystems` is empty
// and the old code fell through to `row.isSet` = false => wired:false, ready:false. That told EVERY
// Spanning client they were one credential short, opened the wizard on a credential nobody asked for,
// and made the "All set" screen unreachable — while readiness itself (correctly) said "ready".
test("an unwired optional credential is flagged optional and never counted as a gap", () => {
  const rows = [
    row("m365-admin", "111", ["m365"]),
    row("spanning", "222", ["spanning"]),
    { ...row("spanning-portal", "", ["spanning"]), optional: true as const },
  ];
  const r = readiness(
    [{ systemKey: "m365", secretNames: ["m365-admin"] }, { systemKey: "spanning", secretNames: ["spanning"] }],
    { "m365-admin": "111", spanning: "222" },
    { m365: "ok", spanning: "ok" }
  );
  const steps = buildSetupSteps(rows, r);
  const portal = steps.find((s) => s.secretName === "spanning-portal")!;
  assert.equal(portal.optional, true, "must be marked optional so the UI can exclude it");
  assert.match(portal.purpose, /Optional/);
  // The client is genuinely fully set up: readiness says so, and the counted steps agree.
  assert.equal(r.tier, "ready");
  const counted = steps.filter((s) => !s.optional || s.wired);
  assert.equal(counted.length, 2, "the untouched optional credential must not be counted");
  assert.equal(counted.every((s) => s.wired && s.ready), true, "'All set' must be reachable");
  // Required credentials are unaffected.
  assert.equal(steps.find((s) => s.secretName === "spanning")!.optional, false);
});

// Once an operator actually wires it, it counts again — a credential you chose to add and got wrong is
// worth surfacing, unlike one you never wanted.
test("a wired optional credential counts toward setup", () => {
  const rows = [
    row("spanning", "222", ["spanning"]),
    { ...row("spanning-portal", "999", ["spanning"]), optional: true as const },
  ];
  const r = readiness([{ systemKey: "spanning", secretNames: ["spanning"] }], { spanning: "222" }, { spanning: "ok" });
  const steps = buildSetupSteps(rows, r);
  const portal = steps.find((s) => s.secretName === "spanning-portal")!;
  assert.equal(portal.optional, true);
  assert.equal(portal.wired, true);
  assert.equal(steps.filter((s) => !s.optional || s.wired).length, 2);
});
