import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecretSearchRecord } from "./delinea-search";
import { rankDelineaSuggestions, SUGGESTION_ALIASES } from "./delinea-suggestions";

const rec = (o: Partial<SecretSearchRecord> & { id: number; name: string }): SecretSearchRecord => ({
  folderPath: "", secretTemplateName: undefined, secretTemplateId: undefined, ...o,
});
const target = { secretName: "adobe", templateName: "Automation - API", subfolders: ["Vendor", "Identity Services"] };

test("aliases exist for the guided vendors", () => {
  for (const k of ["adobe", "zoom", "mimecast", "egnyte", "knowbe4", "slack", "spanning"]) {
    assert.ok(SUGGESTION_ALIASES[k]?.length, `${k} needs aliases`);
  }
});

test("template match, name match, and folder match each contribute, with reasons", () => {
  const cands = [
    rec({ id: 1, name: "Adobe Admin Console (auto)", folderPath: "\\Clients\\Acme !CORE1!\\Vendor", secretTemplateName: "Automation - API" }),
    rec({ id: 2, name: "random note", folderPath: "\\Clients\\Acme !CORE1!\\Networking", secretTemplateName: "Active Directory Account" }),
    rec({ id: 3, name: "UMAPI service", folderPath: "\\Clients\\Acme !CORE1!\\Identity Services", secretTemplateName: "Automation - API" }),
  ];
  const out = rankDelineaSuggestions(cands, target);
  // #1 wins: template + name(adobe) + Vendor folder. #3 next: template + name(umapi) + Identity Services. #2 filtered (score 0).
  assert.deepEqual(out.map((s) => s.secretId), [1, 3]);
  assert.ok(out[0].score > out[1].score);
  assert.ok(out[0].reasons.some((r) => /template/i.test(r)));
  assert.ok(out[0].reasons.some((r) => /adobe/i.test(r)));
  assert.ok(out[0].reasons.some((r) => /Vendor/i.test(r)));
});

test("folderId is the numeric last segment of a Secret Server folderPath, else null", () => {
  // Secret Server folderPath is name-based ("\\Clients\\..\\Vendor"), so folderId is null unless numeric.
  const out = rankDelineaSuggestions([rec({ id: 9, name: "adobe key", folderPath: "\\Clients\\Acme\\Vendor", secretTemplateName: "Automation - API" })], target);
  assert.equal(out[0].folderId, null);
});

test("caps at 25 results", () => {
  const many = Array.from({ length: 40 }, (_, i) => rec({ id: i + 1, name: `adobe ${i}`, secretTemplateName: "Automation - API" }));
  assert.equal(rankDelineaSuggestions(many, target).length, 25);
});
