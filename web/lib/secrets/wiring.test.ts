import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSecretRows, secretIsSet } from "./wiring";

test("secretIsSet is false for empty / unset / REPLACE_ME placeholders", () => {
  assert.equal(secretIsSet(""), false);
  assert.equal(secretIsSet("   "), false);
  assert.equal(secretIsSet("REPLACE_ME"), false);
  assert.equal(secretIsSet("NOT_NEEDED"), false); // manual-step sentinel is not a real credential
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

// An optional secret (spanning-portal) is deliberately absent from ClientSystem.secretNames — listing
// it there would make the system's jobs unclaimable until it was wired. So the wiring panel is the ONLY
// place it can be offered; without a row here the capability is literally unreachable.
test("an optional secret is offered as a row so it can be wired at all", () => {
  const rows = deriveSecretRows([{ systemKey: "spanning", secretNames: ["spanning"] }], []);
  const portal = rows.find((r) => r.name === "spanning-portal");
  assert.ok(portal, "spanning-portal must be offered for a client with Spanning");
  assert.equal(portal!.optional, true);
  assert.deepEqual(portal!.referencedBy, ["spanning"]);
  assert.equal(portal!.isSet, false);
  // ...and the required one is unchanged and NOT optional.
  const api = rows.find((r) => r.name === "spanning");
  assert.equal(api!.optional, undefined);
});

test("a client with no Spanning system is not offered the portal secret", () => {
  const rows = deriveSecretRows([{ systemKey: "mimecast", secretNames: ["mimecast"] }], []);
  assert.equal(rows.some((r) => r.name === "spanning-portal"), false);
});

test("a registry-optional secret is always optional, even when a system lists it in secretNames", () => {
  // The planner strips registry-optional names from a job's required secretNames (attaching them only
  // when wired), so the panel must show them optional too — listing one in secretNames does NOT make
  // it required. The API secret alongside it stays required.
  const rows = deriveSecretRows([{ systemKey: "spanning", secretNames: ["spanning", "spanning-portal"] }], []);
  assert.equal(rows.filter((r) => r.name === "spanning-portal").length, 1);
  assert.equal(rows.find((r) => r.name === "spanning-portal")!.optional, true);
  assert.equal(rows.find((r) => r.name === "spanning")!.optional, undefined);
});

test("ad-dc shows as an OPTIONAL row on an AD client even though the system lists it", () => {
  const rows = deriveSecretRows([{ systemKey: "active-directory", secretNames: ["ad-dc"] }], []);
  assert.equal(rows.find((r) => r.name === "ad-dc")!.optional, true);
});
