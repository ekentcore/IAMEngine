import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVaultFolderId, type DelineaConfig, type Fetcher, type FetchResponse } from "./delinea";
import { apiSetupBySecretName, API_SETUP_CATALOG } from "./api-setup-catalog";
import { checkFieldShape } from "./field-requirements";

const cfg: DelineaConfig = { baseUrl: "https://ss.example.com", username: "u", password: "p" };

// A folder-lookup fetcher: returns a child folder named `present` under any parent; everything else empty.
// findChildFolderByName hits /api/v1/folders?...&filter.searchText=<name>, so we key off searchText.
function folderFetcher(present: string[]): Fetcher {
  return (async (url: string) => {
    const m = /filter\.searchText=([^&]+)/.exec(url);
    const asked = m ? decodeURIComponent(m[1]) : "";
    const records = present.includes(asked) ? [{ id: `id-${asked}`, folderName: asked }] : [];
    return { ok: true, status: 200, json: async () => ({ records }) } as FetchResponse;
  }) as Fetcher;
}

test("resolveVaultFolderId returns the FIRST candidate subfolder that exists, in order", async () => {
  // "Vendor" exists -> used even though "Identity Services" also would.
  assert.equal(await resolveVaultFolderId(cfg, "100", ["Vendor", "Identity Services"], "tok", folderFetcher(["Vendor", "Identity Services"])), "id-Vendor");
  // "Vendor" missing, "Identity Services" present -> falls back to Identity Services.
  assert.equal(await resolveVaultFolderId(cfg, "100", ["Vendor", "Identity Services"], "tok", folderFetcher(["Identity Services"])), "id-Identity Services");
  // Neither exists -> null (caller refuses; never writes to the ROOT).
  assert.equal(await resolveVaultFolderId(cfg, "100", ["Vendor", "Identity Services"], "tok", folderFetcher([])), null);
  // An empty name in the list = redirect disabled -> the parent folder itself.
  assert.equal(await resolveVaultFolderId(cfg, "100", [""], "tok", folderFetcher([])), "100");
});

test("the guided-setup catalog registers the vendor modules with the Vendor subfolder", () => {
  for (const secret of ["adobe", "zoom", "egnyte", "knowbe4", "slack", "spanning", "mimecast", "proofpoint"]) {
    const e = apiSetupBySecretName(secret);
    assert.ok(e, `${secret} should be in the API_SETUP_CATALOG`);
    assert.equal(e!.delineaSubfolder, "Vendor", `${secret} should vault into the Vendor subfolder`);
    assert.ok(Array.isArray(e!.steps) && e!.steps.length > 0, `${secret} should carry setup steps`);
  }
});

test("no duplicate secretName entries in the catalog", () => {
  const names = API_SETUP_CATALOG.map((e) => e.secretName);
  assert.equal(new Set(names).size, names.length);
});

test("field requirements for the newly-added vendors match the runner's required fields", () => {
  // Zoom S2S OAuth: account id + client id + client secret (all required).
  assert.ok(checkFieldShape("zoom", ["account id", "client id", "client secret"], { clientHasTenantHint: false }).ok);
  assert.equal(checkFieldShape("zoom", ["account id", "client id"], { clientHasTenantHint: false }).ok, false); // missing secret
  // Egnyte: domain + api token (both required).
  assert.ok(checkFieldShape("egnyte", ["egnyte domain", "api token"], { clientHasTenantHint: false }).ok);
  assert.equal(checkFieldShape("egnyte", ["api token"], { clientHasTenantHint: false }).ok, false); // missing domain
  // KnowBe4: token required, base url optional (so token alone passes).
  assert.ok(checkFieldShape("knowbe4", ["SCIM token"], { clientHasTenantHint: false }).ok);
  assert.equal(checkFieldShape("knowbe4", ["base url (region)"], { clientHasTenantHint: false }).ok, false); // missing token
});
