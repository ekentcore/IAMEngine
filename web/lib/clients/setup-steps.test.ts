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
