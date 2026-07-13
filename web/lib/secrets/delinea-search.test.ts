import { test } from "node:test";
import assert from "node:assert/strict";
import { listAllFolders, listFolderSecrets } from "./delinea-search";
import type { DelineaConfig, Fetcher } from "./delinea";

const cfg: DelineaConfig = { baseUrl: "https://ctg.secretservercloud.com", username: "svc", password: "pw" };

test("listAllFolders pages until a short page and maps records", async () => {
  const calls: string[] = [];
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: i, folderName: `F${i}`, folderPath: `\\F${i}`, parentFolderId: 18 }));
  const page2 = [{ id: 2000, folderName: "Last", folderPath: "\\Last", parentFolderId: null }];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url);
    assert.equal(init?.headers?.Authorization, "Bearer tok");
    const skip = Number(new URL(url).searchParams.get("skip"));
    return { ok: true, status: 200, json: async () => ({ records: skip === 0 ? page1 : page2, total: 1001 }) };
  };
  const out = await listAllFolders(cfg, "tok", fetcher);
  assert.equal(out.length, 1001);
  assert.equal(calls.length, 2);
  assert.deepEqual(out[1000], { id: 2000, folderName: "Last", folderPath: "\\Last", parentFolderId: null });
});

test("listFolderSecrets asks for the full inventory (scope=All, restricted, subfolders)", async () => {
  let seenUrl = "";
  const fetcher: Fetcher = async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => ({ records: [{ id: 5, name: "IAM Engine", folderPath: "\\Clients\\X", secretTemplateId: 6045, secretTemplateName: "Entra Azure AD Account" }], total: 1 }) };
  };
  const out = await listFolderSecrets(cfg, 13085, "tok", fetcher);
  const params = new URL(seenUrl).searchParams;
  assert.equal(params.get("filter.folderId"), "13085");
  assert.equal(params.get("filter.includeSubFolders"), "true");
  assert.equal(params.get("filter.includeRestricted"), "true");
  assert.equal(params.get("filter.scope"), "All");
  assert.deepEqual(out, [{ id: 5, name: "IAM Engine", folderPath: "\\Clients\\X", secretTemplateId: 6045, secretTemplateName: "Entra Azure AD Account" }]);
});

test("a failed page surfaces as an error rather than a truncated result", async () => {
  const fetcher: Fetcher = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => listAllFolders(cfg, "tok", fetcher), /500/);
});
