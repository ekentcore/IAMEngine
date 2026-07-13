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

test("TOC-shaped KB: entries are the headers, the TOC itself is dropped, colon-lines stay steps", () => {
  const text = [
    "Table of Contents",
    "",
    "- ServiceNow",
    "- Microsoft 365",
    "- Pass to Dedicated/Field",
    "",
    "All passwords should be auto generated.",
    "",
    "ServiceNow",
    "",
    "Confirm the user is set up in ServiceNow and populate the following fields:",
    "- Email",
    "- Title",
    "",
    "Microsoft 365",
    "",
    "Connect to 365 Admin Center using CoreSecret.",
    "Create the new user:",
    "- Add User",
    "",
    "Pass to Dedicated/Field",
    "",
    "The remaining steps go to dedicated support.",
  ].join("\n");
  const secs = parseRunbookText(text);
  assert.deepEqual(secs.map((s) => s.title), ["Overview", "ServiceNow", "Microsoft 365", "Pass to Dedicated/Field"]);
  assert.equal(secs[1].systemKey, "servicenow");
  assert.equal(secs[2].systemKey, "m365");
  // the intro prose lands in Overview, not inside a phantom "Table of Contents" section
  assert.match(secs[0].steps.join("\n"), /auto generated/);
  // a short colon-line inside a section is a step, not a new section, when a TOC exists
  assert.match(secs[2].steps.join("\n"), /Create the new user/);
  assert.equal(secs[2].steps.includes("Add User"), true);
});

test("documents without a TOC keep the old header heuristics", () => {
  const secs = parseRunbookText("Active Directory\n- create the user\n\nLicensing:\n- assign E3");
  assert.deepEqual(secs.map((s) => s.title), ["Active Directory", "Licensing"]);
});

test("a modeled-system bare line missing from a stale TOC still opens a section", () => {
  const text = [
    "Table of Contents",
    "- Microsoft 365",
    "- Zoom",
    "",
    "Microsoft 365",
    "Create the user.",
    "",
    "Zoom",
    "- Add user with Zoom Workplace Business license.",
    "",
    "KnowBe4", // added to the KB after the TOC was written
    "- Add the user to the DCG Users group.",
  ].join("\n");
  const secs = parseRunbookText(text);
  assert.deepEqual(secs.map((s) => s.systemKey), ["m365", "zoom", "knowbe4"]);
  assert.deepEqual(secs[2].steps, ["Add the user to the DCG Users group."]);
});
