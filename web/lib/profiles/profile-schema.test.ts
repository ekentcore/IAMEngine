import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.filename, "../../../..");

test("identity.adDomain is an accepted optional string", () => {
  const schema = JSON.parse(readFileSync(resolve(ROOT, "profiles/_schema.json"), "utf8"));
  const identity = schema.properties?.identity ?? schema.$defs?.identity;
  assert.ok(identity, "the schema has an identity block");
  assert.ok(identity.properties.adDomain, "identity.adDomain is declared");
  assert.equal(identity.properties.adDomain.type, "string");
  // It must stay OPTIONAL — every existing profile omits it.
  assert.ok(!(identity.required ?? []).includes("adDomain"), "adDomain is not required");
  // additionalProperties is false on this block, so an undeclared key would be rejected.
  assert.equal(identity.additionalProperties, false);
});
