import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuidedValues, deriveSpanningValues } from "./guided-api-values";
import { SECRET_FIELD_REQUIREMENTS, checkFieldShape } from "./field-requirements";
import { API_SETUP_CATALOG } from "./api-setup-catalog";

// Regression for the guided-api-setup 422: pasted values keyed by a field's human LABEL
// ("admin email (X-User)", "region or base url", …) never satisfy checkFieldShape, which matches
// against each requirement's `anyOf` synonyms. buildGuidedValues must key by `f.anyOf[0]` instead, so
// a fully-filled guided-setup form always passes the same shape check the create route runs.
for (const entry of API_SETUP_CATALOG) {
  test(`${entry.systemKey}: a fully-filled guided-setup form passes checkFieldShape`, () => {
    const reqs = SECRET_FIELD_REQUIREMENTS[entry.secretName] ?? [];
    // Mirror GuidedApiSetup's visible inputs: required fields, minus the one a spanning entry derives.
    const fields = reqs.filter((f) => !f.optional).filter((f) => entry.derive !== "spanning" || f.label !== "region or base url");
    assert.ok(fields.length > 0, `${entry.secretName} should have at least one required field`);

    // Simulate the component's input state: keyed by label, one non-empty value per required field —
    // exactly what GuidedApiSetup's `values` state holds when every visible input is filled in.
    const valueByFieldKey: Record<string, string> = {};
    for (const f of fields) valueByFieldKey[f.label] = `test-value-for-${f.label}`;

    const region = entry.derive === "spanning" ? undefined : entry.regionOptions?.[0];
    const derived = entry.derive === "spanning" ? deriveSpanningValues("user@acme.com", entry.serviceOptions![0], entry.regionOptions![0]) : {};
    const values = { ...buildGuidedValues(fields, valueByFieldKey, region), ...derived };

    const verdict = checkFieldShape(entry.secretName, Object.keys(values));
    assert.deepEqual(verdict, { ok: true, missing: [] }, `unexpected missing fields for ${entry.secretName}: ${JSON.stringify(verdict.missing)}`);
  });
}

test("proofpoint: region select contributes under the 'Region' key", () => {
  const reqs = SECRET_FIELD_REQUIREMENTS.proofpoint;
  const fields = reqs.filter((f) => !f.optional);
  const valueByFieldKey: Record<string, string> = {};
  for (const f of fields) valueByFieldKey[f.label] = `v-${f.label}`;

  const values = buildGuidedValues(fields, valueByFieldKey, "eu1");
  assert.equal(values.Region, "eu1");
});

test("no region arg -> no Region key added", () => {
  const reqs = SECRET_FIELD_REQUIREMENTS.mimecast;
  const fields = reqs.filter((f) => !f.optional);
  const valueByFieldKey: Record<string, string> = {};
  for (const f of fields) valueByFieldKey[f.label] = `v-${f.label}`;

  const values = buildGuidedValues(fields, valueByFieldKey);
  assert.equal("Region" in values, false);
});

test("blank/whitespace-only entries are omitted, not sent as empty strings", () => {
  const reqs = SECRET_FIELD_REQUIREMENTS.mimecast;
  const fields = reqs.filter((f) => !f.optional);
  const valueByFieldKey: Record<string, string> = { [fields[0].label]: "   " };

  const values = buildGuidedValues(fields, valueByFieldKey);
  assert.equal(Object.keys(values).length, 0);
});

test("deriveSpanningValues builds the service/region API URL and the suffix-less account id", () => {
  const v = deriveSpanningValues("admin@acme.com", "o365", "us");
  assert.equal(v.apiURL, "https://o365-api-us.spanningbackup.com");
  assert.equal(v.AccountID, "acme");
  // Google Workspace tenant, other region, casing normalized.
  const g = deriveSpanningValues("Admin@BrightonPark.org", "Google", "EU");
  assert.equal(g.apiURL, "https://google-api-eu.spanningbackup.com");
  assert.equal(g.AccountID, "brightonpark");
  // Multi-label domain: "without the suffix" = the first label.
  assert.equal(deriveSpanningValues("x@acme.co.uk", "o365", "uk").AccountID, "acme");
  // No usable domain -> no AccountID key (never an empty string).
  assert.equal("AccountID" in deriveSpanningValues("not-an-email", "o365", "us"), false);
});

test("spanning: the modal's typed fields + derived values pass checkFieldShape with distinct keys", () => {
  // Mirror GuidedApiSetup's spanning variant: text inputs are the non-optional requirements MINUS the
  // derived "region or base url"; apiURL/AccountID come from deriveSpanningValues.
  const reqs = SECRET_FIELD_REQUIREMENTS.spanning;
  const fields = reqs.filter((f) => !f.optional).filter((f) => f.label !== "region or base url");
  const typed = buildGuidedValues(fields, { "login email": "admin@acme.com", "api token": "tok-1" });
  const values = { ...typed, ...deriveSpanningValues("admin@acme.com", "o365", "us") };
  assert.deepEqual(Object.keys(values).sort(), ["AccountID", "ClientID", "ClientSecret", "apiURL"].sort());
  assert.equal(values.ClientID, "admin@acme.com"); // the login email, NOT clobbered by the account id
  assert.deepEqual(checkFieldShape("spanning", Object.keys(values)), { ok: true, missing: [] });
});

test("keys the output by the CANONICAL synonym (anyOf[0]), not the label", () => {
  const reqs = SECRET_FIELD_REQUIREMENTS.proofpoint;
  const fields = reqs.filter((f) => !f.optional);
  const valueByFieldKey: Record<string, string> = {};
  for (const f of fields) valueByFieldKey[f.label] = `v-${f.label}`;

  const values = buildGuidedValues(fields, valueByFieldKey);
  assert.deepEqual(Object.keys(values).sort(), ["X-Password", "X-User", "Domain"].sort());
});
