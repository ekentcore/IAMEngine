import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuggestions } from "./build-suggestions";
import type { SecretSearchRecord } from "./delinea-search";

const secrets: SecretSearchRecord[] = [
  { id: 1, name: "Adobe Admin (auto)", folderPath: "\\C\\Vendor", secretTemplateName: "Automation - API" },
  { id: 2, name: "Adobe old", folderPath: "\\C\\Vendor", secretTemplateName: "Automation - API" },
  { id: 3, name: "unrelated", folderPath: "\\C\\Networking", secretTemplateName: "Active Directory Account" },
];

test("no client folder -> folderResolved false, no fetches", async () => {
  let listed = false;
  const r = await buildSuggestions({ listSecrets: async () => { listed = true; return []; }, fetchNote: async () => "x" },
    { clientFolderId: null, secretName: "adobe", subfolders: ["Vendor"], noteTopN: 5 });
  assert.equal(r.folderResolved, false);
  assert.deepEqual(r.suggestions, []);
  assert.equal(listed, false);
});

test("ranks, and fetches notes only for the top N", async () => {
  const noteCalls: number[] = [];
  const r = await buildSuggestions(
    { listSecrets: async () => secrets, fetchNote: async (id) => { noteCalls.push(id); return `note-${id}`; } },
    { clientFolderId: "500", secretName: "adobe", subfolders: ["Vendor"], noteTopN: 1 });
  assert.equal(r.folderResolved, true);
  assert.equal(r.suggestions.length, 2);            // #3 filtered (score 0)
  assert.equal(r.suggestions[0].note, "note-1");     // top-1 got a note
  assert.equal(r.suggestions[1].note, undefined);    // beyond N: no note
  assert.deepEqual(noteCalls, [r.suggestions[0].secretId]);
});

test("a failing note fetch is swallowed (suggestion kept, note omitted)", async () => {
  const r = await buildSuggestions(
    { listSecrets: async () => secrets, fetchNote: async () => { throw new Error("boom"); } },
    { clientFolderId: "500", secretName: "adobe", subfolders: ["Vendor"], noteTopN: 5 });
  assert.equal(r.suggestions.length, 2);
  assert.equal(r.suggestions[0].note, undefined);
});
