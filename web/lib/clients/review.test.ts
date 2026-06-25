import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicFindings, type ReviewFinding } from "./review";
import type { ClientListItem } from "./types";

function client(over: Partial<ClientListItem>): ClientListItem {
  return {
    id: over.slug ?? "id", slug: "s", name: "Acme Corp", primaryDomain: "acme.com",
    backbone: null, status: "active", coreId: null, region: null,
    emailDomain: null, usernamePattern: "{first}.{last}",
    systemKeys: [], systemCount: 0, modeled: false,
    parentId: null, parentName: null, parentSystemKeys: [], coverage: "none",
    ...over,
  } as ClientListItem;
}
const cats = (f: ReviewFinding[]) => f.map((x) => x.category).sort();

test("clean client produces no findings", () => {
  assert.deepEqual(heuristicFindings([client({})]), []);
});

test("missing domain is flagged high", () => {
  const f = heuristicFindings([client({ primaryDomain: "" })]);
  assert.equal(f.length, 1);
  assert.equal(f[0].category, "missing-domain");
  assert.equal(f[0].severity, "high");
});

test("malformed domain (URL, no TLD, GUID, spaces) is flagged", () => {
  for (const d of ["https://acme.com", "acme", "cf7be29f-a0f7-4c2f-9778-f3684097d5d6".padEnd(36, "0").slice(0, 36), "acme com"]) {
    const f = heuristicFindings([client({ primaryDomain: d })]);
    assert.equal(f[0]?.category, "malformed-domain", `expected malformed for "${d}"`);
  }
});

test("domain that doesn't match the company name is flagged (JAMS -> newcoinc.com)", () => {
  const f = heuristicFindings([client({ name: "JAMS Software LLC", primaryDomain: "newcoinc.com" })]);
  assert.ok(f.some((x) => x.category === "domain-name-mismatch"));
});

test("a matching domain is NOT flagged as mismatch", () => {
  assert.deepEqual(heuristicFindings([client({ name: "Brighton Park Capital", primaryDomain: "brightonpark.com" })]), []);
  // initialism match
  assert.deepEqual(heuristicFindings([client({ name: "Boys and Girls Club", primaryDomain: "bgc.org" })]), []);
});

test("empty / token-less email format is flagged", () => {
  assert.equal(heuristicFindings([client({ usernamePattern: "" })])[0].category, "email-format");
  assert.ok(cats(heuristicFindings([client({ usernamePattern: "firstlast" })])).includes("email-format"));
});
