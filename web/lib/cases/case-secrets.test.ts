import { test } from "node:test";
import assert from "node:assert/strict";
import { serverHintFromLabel, stepRunsOn, effectiveExternalId } from "./case-secrets";

test("serverHintFromLabel: pulls the host from a parenthetical", () => {
  assert.equal(serverHintFromLabel("Domain controller (core-cce-dc01) admin"), "core-cce-dc01");
  assert.equal(serverHintFromLabel("On-prem Exchange (core-cce1-ex01) admin"), "core-cce1-ex01");
  assert.equal(serverHintFromLabel("Entra app cert + tenant"), null);
  assert.equal(serverHintFromLabel("Entra app (On-Boarding Script) cert + tenant"), null); // app name, not a host
  assert.equal(serverHintFromLabel(null), null);
});

test("stepRunsOn: on-prem systems -> client-network agent (with server); cloud -> central", () => {
  assert.equal(stepRunsOn("active-directory", "ad_synced", ["core-cce-dc01"]), "Client-network agent · core-cce-dc01");
  assert.equal(stepRunsOn("exchange", "ad_synced", ["core-cce1-ex01"]), "Client-network agent · core-cce1-ex01");
  assert.equal(stepRunsOn("m365", "ad_synced", []), "Central / cloud runner");
  assert.equal(stepRunsOn("entra", "entra", []), "Central / cloud runner");
  assert.equal(stepRunsOn("servicenow", "ad_synced", []), "App / manual");
  // exchange is cloud-only for an entra client (no on-prem)
  assert.equal(stepRunsOn("exchange", "entra", []), "Central / cloud runner");
});

test("effectiveExternalId: case override wins; else client; else missing (REPLACE_ME = unset)", () => {
  assert.deepEqual(effectiveExternalId("ad-dc", { "ad-dc": "111" }, "999"), { externalId: "111", source: "case" });
  assert.deepEqual(effectiveExternalId("ad-dc", {}, "999"), { externalId: "999", source: "client" });
  assert.deepEqual(effectiveExternalId("ad-dc", null, "REPLACE_ME"), { externalId: null, source: "missing" });
  assert.deepEqual(effectiveExternalId("ad-dc", { "ad-dc": "REPLACE_ME" }, "999"), { externalId: "999", source: "client" });
  assert.deepEqual(effectiveExternalId("ad-dc", null, null), { externalId: null, source: "missing" });
});
