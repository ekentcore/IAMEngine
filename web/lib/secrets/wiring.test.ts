import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSecretRows, secretIsSet } from "./wiring";

test("secretIsSet is false for empty / unset / REPLACE_ME placeholders", () => {
  assert.equal(secretIsSet(""), false);
  assert.equal(secretIsSet("   "), false);
  assert.equal(secretIsSet("REPLACE_ME"), false);
  assert.equal(secretIsSet("48213"), true);
});

test("deriveSecretRows unions the secret names referenced across systems", () => {
  const rows = deriveSecretRows(
    [
      { systemKey: "m365", secretNames: ["m365-admin"] },
      { systemKey: "exchange", secretNames: ["m365-admin"] }, // shares the same secret
      { systemKey: "mimecast", secretNames: ["mimecast"] },
    ],
    []
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.deepEqual([...byName.keys()].sort(), ["m365-admin", "mimecast"]);
  // referencedBy lists every system that uses the secret
  assert.deepEqual(byName.get("m365-admin")!.referencedBy.sort(), ["exchange", "m365"]);
  assert.equal(byName.get("m365-admin")!.isSet, false); // no mapping yet
  assert.equal(byName.get("m365-admin")!.externalId, "");
});

test("deriveSecretRows merges existing mappings and marks them set", () => {
  const rows = deriveSecretRows(
    [{ systemKey: "m365", secretNames: ["m365-admin"] }],
    [
      { name: "m365-admin", externalId: "48213", label: "365 Admin", provider: "delinea" },
      { name: "ad-dc", externalId: "REPLACE_ME", label: null, provider: "delinea" }, // referenced by nothing now
    ]
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.equal(byName.get("m365-admin")!.externalId, "48213");
  assert.equal(byName.get("m365-admin")!.label, "365 Admin");
  assert.equal(byName.get("m365-admin")!.isSet, true);
  // an orphaned mapping (no longer referenced) is still surfaced, but unset (REPLACE_ME)
  assert.ok(byName.has("ad-dc"));
  assert.deepEqual(byName.get("ad-dc")!.referencedBy, []);
  assert.equal(byName.get("ad-dc")!.isSet, false);
});

test("deriveSecretRows returns rows sorted by name", () => {
  const rows = deriveSecretRows(
    [{ systemKey: "z", secretNames: ["zoom", "adobe", "m365-admin"] }],
    []
  );
  assert.deepEqual(rows.map((r) => r.name), ["adobe", "m365-admin", "zoom"]);
});
