import { test } from "node:test";
import assert from "node:assert/strict";
import { serverHintFromLabel, stepRunsOn, effectiveExternalId, missingRequiredSecrets } from "./case-secrets";

test("missingRequiredSecrets: flags names with no usable reference (case override > client default)", () => {
  const clientSecrets = new Map<string, string | null>([["ad-dc", "55501"], ["m365-admin", "REPLACE_ME"], ["mimecast", null]]);
  // ad-dc set on client, m365-admin overridden on case, mimecast + exchange-onprem unset
  const missing = missingRequiredSecrets(["ad-dc", "m365-admin", "mimecast", "exchange-onprem"], { "m365-admin": "55502" }, clientSecrets);
  assert.deepEqual(missing.sort(), ["exchange-onprem", "mimecast"]);
});

test("missingRequiredSecrets: empty / no required secrets -> nothing missing", () => {
  assert.deepEqual(missingRequiredSecrets([], {}, new Map()), []);
  assert.deepEqual(missingRequiredSecrets(undefined, undefined, new Map()), []);
});

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

test("effectiveExternalId: NOT_NEEDED sentinel -> not-needed (no usable ref, but intentional)", () => {
  // A secret marked "not needed" (module is a manual step) resolves to no reference but a distinct
  // source so it is NOT treated as missing.
  assert.deepEqual(effectiveExternalId("egnyte", null, "NOT_NEEDED"), { externalId: null, source: "not_needed" });
  // A case override still wins over a client "not needed" marker.
  assert.deepEqual(effectiveExternalId("egnyte", { egnyte: "222" }, "NOT_NEEDED"), { externalId: "222", source: "case" });
  // The marker can also come from a case override.
  assert.deepEqual(effectiveExternalId("egnyte", { egnyte: "NOT_NEEDED" }, null), { externalId: null, source: "not_needed" });
});

test("missingRequiredSecrets: NOT_NEEDED secrets do not block (manual-step modules)", () => {
  const clientSecrets = new Map<string, string | null>([["egnyte", "NOT_NEEDED"], ["m365-admin", null]]);
  // egnyte marked not-needed -> not missing; m365-admin still unset -> missing
  const missing = missingRequiredSecrets(["egnyte", "m365-admin"], {}, clientSecrets);
  assert.deepEqual(missing, ["m365-admin"]);
});
