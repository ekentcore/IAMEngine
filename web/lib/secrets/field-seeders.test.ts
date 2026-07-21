import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD_SEEDERS, parseGoogleServiceAccountKey, utf8ToBase64 } from "./field-seeders";
import { SECRET_FIELD_REQUIREMENTS, checkFieldShape } from "./field-requirements";

const SA_KEY = {
  type: "service_account",
  project_id: "client-proj",
  private_key_id: "abc123",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n",
  client_email: "coretelligent-iam@client-proj.iam.gserviceaccount.com",
  client_id: "104857600000000000000",
  token_uri: "https://oauth2.googleapis.com/token",
};

test("utf8ToBase64 round-trips through Buffer decode, including non-latin1 text", () => {
  for (const text of ["plain ascii", JSON.stringify(SA_KEY), "Ünïcode – ✓ 日本語"]) {
    assert.equal(Buffer.from(utf8ToBase64(text), "base64").toString("utf8"), text);
  }
});

test("google key file seeds ClientSecret (base64 of the whole file) + accountid (client_email)", () => {
  const fileText = JSON.stringify(SA_KEY, null, 2);
  const seeded = parseGoogleServiceAccountKey(fileText);
  assert.equal(seeded.values.accountid, SA_KEY.client_email);
  // ClientSecret must be the base64 of the FILE as-is — the runner decodes it and re-parses the JSON.
  const decoded = JSON.parse(Buffer.from(seeded.values.ClientSecret, "base64").toString("utf8"));
  assert.equal(decoded.private_key, SA_KEY.private_key);
  assert.equal(decoded.client_email, SA_KEY.client_email);
  assert.ok(seeded.note.includes(SA_KEY.client_email));
});

test("rejects a non-JSON file with an operator-readable message", () => {
  assert.throws(() => parseGoogleServiceAccountKey("-----BEGIN PRIVATE KEY-----"), /isn't JSON/);
});

test("rejects JSON that is not a service-account key (e.g. an OAuth client download)", () => {
  const oauthClient = JSON.stringify({ installed: { client_id: "x", client_secret: "y" } });
  assert.throws(() => parseGoogleServiceAccountKey(oauthClient), /isn't a service-account key/);
});

test("rejects a service-account key missing client_email or private_key", () => {
  assert.throws(() => parseGoogleServiceAccountKey(JSON.stringify({ type: "service_account", client_email: "a@b.c" })), /missing client_email or private_key/);
  assert.throws(() => parseGoogleServiceAccountKey(JSON.stringify({ type: "service_account", private_key: "k" })), /missing client_email or private_key/);
});

// The registry's promises must hold against the field requirements the form renders from.
for (const [secretName, seeder] of Object.entries(FIELD_SEEDERS)) {
  test(`${secretName}: seeder 'fills' labels exist among the secret's field requirements`, () => {
    const reqs = SECRET_FIELD_REQUIREMENTS[secretName] ?? [];
    for (const label of seeder.fills) {
      assert.ok(reqs.some((r) => r.label === label), `seeder fills unknown label "${label}"`);
    }
  });
}

test("google-admin: seeded values + a typed apiURL satisfy checkFieldShape (same check the create route runs)", () => {
  const seeded = parseGoogleServiceAccountKey(JSON.stringify(SA_KEY));
  const values = { ...seeded.values, apiURL: "super-admin@client.com" };
  assert.deepEqual(checkFieldShape("google-admin", Object.keys(values)), { ok: true, missing: [] });
  // And the seeder's declared fill set matches what parse actually emitted.
  assert.deepEqual(Object.keys(seeded.values).sort(), [...FIELD_SEEDERS["google-admin"].fills].sort());
});
