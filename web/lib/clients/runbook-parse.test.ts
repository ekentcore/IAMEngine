import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunbookText } from "./runbook-parse";

test("markdown headers + bullets, maps known systems", () => {
  const out = parseRunbookText(`# Active Directory
- create the user in the OU
- add to base groups

## Microsoft 365
1. assign the E3 license
2. add to M365 groups`);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Active Directory");
  assert.equal(out[0].systemKey, "active-directory");
  assert.equal(out[0].status, "automated");
  assert.deepEqual(out[0].steps, ["create the user in the OU", "add to base groups"]);
  assert.equal(out[1].systemKey, "m365");
  assert.deepEqual(out[1].steps, ["assign the E3 license", "add to M365 groups"]);
});

test("bare title line followed by a bullet is a header", () => {
  const out = parseRunbookText(`Active Directory
- create user

Exchange
- enable remote mailbox`);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Active Directory");
  assert.equal(out[1].title, "Exchange");
  assert.equal(out[1].systemKey, "exchange");
});

test("title with trailing colon + nested indentation", () => {
  const out = parseRunbookText(`Active Directory:
- set attributes
  - title
  - department`);
  assert.equal(out[0].title, "Active Directory");
  assert.deepEqual(out[0].steps, ["set attributes", "  title", "  department"]);
});

test("an unmapped section gets systemKey null + unmodeled", () => {
  const out = parseRunbookText(`Order the laptop
- email IT procurement
- ship to the new hire`);
  assert.equal(out.length, 1);
  assert.equal(out[0].systemKey, null);
  assert.equal(out[0].status, "unmodeled");
});

test("prose before the first header becomes an Overview section", () => {
  const out = parseRunbookText(`This client has no KB; steps from the script.

Active Directory
- create user`);
  assert.equal(out[0].title, "Overview");
  assert.deepEqual(out[0].steps, ["This client has no KB; steps from the script."]);
  assert.equal(out[1].title, "Active Directory");
});

test("empty input yields no sections", () => {
  assert.deepEqual(parseRunbookText(""), []);
  assert.deepEqual(parseRunbookText("\n\n  \n"), []);
});
