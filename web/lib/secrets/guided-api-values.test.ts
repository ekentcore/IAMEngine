import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuidedValues } from "./guided-api-values";
import { SECRET_FIELD_REQUIREMENTS, checkFieldShape } from "./field-requirements";
import { API_SETUP_CATALOG } from "./api-setup-catalog";

// Regression for the guided-api-setup 422: pasted values keyed by a field's human LABEL
// ("admin email (X-User)", "region or base url", …) never satisfy checkFieldShape, which matches
// against each requirement's `anyOf` synonyms. buildGuidedValues must key by `f.anyOf[0]` instead, so
// a fully-filled guided-setup form always passes the same shape check the create route runs.
for (const entry of API_SETUP_CATALOG) {
  test(`${entry.systemKey}: a fully-filled guided-setup form passes checkFieldShape`, () => {
    const reqs = SECRET_FIELD_REQUIREMENTS[entry.secretName] ?? [];
    const fields = reqs.filter((f) => !f.optional);
    assert.ok(fields.length > 0, `${entry.secretName} should have at least one required field`);

    // Simulate the component's input state: keyed by label, one non-empty value per required field —
    // exactly what GuidedApiSetup's `values` state holds when every visible input is filled in.
    const valueByFieldKey: Record<string, string> = {};
    for (const f of fields) valueByFieldKey[f.label] = `test-value-for-${f.label}`;

    const region = entry.regionOptions ? entry.regionOptions[0] : undefined;
    const values = buildGuidedValues(fields, valueByFieldKey, region);

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

test("keys the output by the CANONICAL synonym (anyOf[0]), not the label", () => {
  const reqs = SECRET_FIELD_REQUIREMENTS.proofpoint;
  const fields = reqs.filter((f) => !f.optional);
  const valueByFieldKey: Record<string, string> = {};
  for (const f of fields) valueByFieldKey[f.label] = `v-${f.label}`;

  const values = buildGuidedValues(fields, valueByFieldKey);
  assert.deepEqual(Object.keys(values).sort(), ["X-Password", "X-User", "Domain"].sort());
});
