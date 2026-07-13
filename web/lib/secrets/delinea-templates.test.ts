import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSlug,
  templateEnvKey,
  defaultFieldMap,
  templateFor,
  folderIdFor,
  delineaWriteConfigFromEnv,
  writeAccountConfigured,
  delineaWriteConfigured,
  delineaWriteSummary,
} from "./delinea-templates";

test("defaultSlug lowercases and strips non-alnum", () => {
  assert.equal(defaultSlug("TenantId"), "tenantid");
  assert.equal(defaultSlug("Client Secret"), "clientsecret");
  assert.equal(defaultSlug("X-User"), "xuser");
});

test("templateEnvKey normalizes a secret name to an env key", () => {
  assert.equal(templateEnvKey("m365-admin"), "DELINEA_TEMPLATE_M365_ADMIN");
  assert.equal(templateEnvKey("spanning"), "DELINEA_TEMPLATE_SPANNING");
});

test("defaultFieldMap seeds label -> slug from the field requirements", () => {
  const m = defaultFieldMap("m365-admin");
  // The labels name BOTH spellings of the app-registration credential (Delinea's two templates call
  // the same pair Username/Password and appID/Secret); the slug is still the canonical first synonym.
  assert.equal(m["admin username / app id"], "username");
  assert.equal(m["admin password / client secret"], "password");
  assert.equal(m["tenant id / domain"], "tenantid");
  // Unknown secret -> empty map (no rule, no warning).
  assert.deepEqual(defaultFieldMap("nope"), {});
});

test("templateFor returns null when no template id is configured", () => {
  assert.equal(templateFor("m365-admin", {}), null);
});

test("templateFor reads a per-key env id and merges the default field map", () => {
  const t = templateFor("m365-admin", { DELINEA_TEMPLATE_M365_ADMIN: "6001" });
  assert.ok(t);
  assert.equal(t!.templateId, 6001);
  assert.equal(t!.fieldMap["admin username / app id"], "username");
});

test("templateFor reads DELINEA_TEMPLATE_MAP (bare id and object form) and applies fieldMap overrides", () => {
  const bare = templateFor("spanning", { DELINEA_TEMPLATE_MAP: JSON.stringify({ spanning: 7 }) });
  assert.equal(bare!.templateId, 7);

  const obj = templateFor("mimecast", {
    DELINEA_TEMPLATE_MAP: JSON.stringify({ mimecast: { templateId: 42, fieldMap: { "client secret": "api-secret" } } }),
  });
  assert.equal(obj!.templateId, 42);
  assert.equal(obj!.fieldMap["client secret"], "api-secret"); // override wins
  assert.equal(obj!.fieldMap["client id"], "clientid"); // default retained
});

test("templateFor: the map entry wins over the per-key env id", () => {
  const t = templateFor("zoom", { DELINEA_TEMPLATE_ZOOM: "1", DELINEA_TEMPLATE_MAP: JSON.stringify({ zoom: 9 }) });
  assert.equal(t!.templateId, 9);
});

test("templateFor tolerates malformed DELINEA_TEMPLATE_MAP JSON", () => {
  assert.equal(templateFor("m365-admin", { DELINEA_TEMPLATE_MAP: "{ not json" }), null);
});

test("folderIdFor prefers the client field, falls back to DELINEA_FOLDER_MAP, else null", () => {
  assert.equal(folderIdFor("acme", "142", {}), "142");
  assert.equal(folderIdFor("acme", null, { DELINEA_FOLDER_MAP: JSON.stringify({ acme: 200 }) }), "200");
  assert.equal(folderIdFor("acme", "  ", { DELINEA_FOLDER_MAP: JSON.stringify({ other: 1 }) }), null);
  assert.equal(folderIdFor("acme", null, {}), null);
});

test("write account reuses read creds unless a distinct write account is set", () => {
  assert.equal(writeAccountConfigured(delineaWriteConfigFromEnv({})), false);
  const reused = delineaWriteConfigFromEnv({ DELINEA_BASE_URL: "https://x/", DELINEA_USER: "svc", DELINEA_PASSWORD: "pw" });
  assert.equal(reused.baseUrl, "https://x"); // trailing slash trimmed
  assert.equal(reused.username, "svc");
  assert.equal(writeAccountConfigured(reused), true);

  const distinct = delineaWriteConfigFromEnv({ DELINEA_BASE_URL: "https://x", DELINEA_USER: "read", DELINEA_PASSWORD: "rp", DELINEA_WRITE_USER: "write", DELINEA_WRITE_PASSWORD: "wp" });
  assert.equal(distinct.username, "write");
  assert.equal(distinct.password, "wp");
});

test("delineaWriteConfigured requires account + folder + template; reports exactly what's missing", () => {
  const none = delineaWriteConfigured({ slug: "acme", secretName: "m365-admin", env: {} });
  assert.equal(none.ok, false);
  assert.equal(none.hasAccount, false);
  assert.equal(none.hasFolder, false);
  assert.equal(none.hasTemplate, false);
  assert.equal(none.missing.length, 3);

  const full = delineaWriteConfigured({
    slug: "acme",
    secretName: "m365-admin",
    clientFolderId: "142",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "svc", DELINEA_PASSWORD: "pw", DELINEA_TEMPLATE_M365_ADMIN: "6001" },
  });
  assert.equal(full.ok, true);
  assert.deepEqual(full.missing, []);

  // account + template present, folder missing -> only folder flagged
  const noFolder = delineaWriteConfigured({
    slug: "acme",
    secretName: "m365-admin",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "svc", DELINEA_PASSWORD: "pw", DELINEA_TEMPLATE_M365_ADMIN: "6001" },
  });
  assert.equal(noFolder.ok, false);
  assert.equal(noFolder.hasFolder, false);
  assert.equal(noFolder.missing.length, 1);
  assert.match(noFolder.missing[0], /folder/i);
});

test("delineaWriteSummary shapes the per-secret UI prop", () => {
  const s = delineaWriteSummary({
    slug: "acme",
    clientFolderId: "142",
    secretNames: ["m365-admin", "spanning"],
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "svc", DELINEA_PASSWORD: "pw", DELINEA_TEMPLATE_M365_ADMIN: "6001" },
  });
  assert.equal(s.hasAccount, true);
  assert.equal(s.folderId, "142");
  assert.equal(s.templates["m365-admin"], true);
  assert.equal(s.templates["spanning"], false); // no template configured for spanning
});
