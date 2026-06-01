import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGroups } from "./group-resolver";
import type { GroupSheet } from "./xls-groups";

const sheet: GroupSheet = {
  sheetName: "Groups",
  headers: ["Department", "Groups"],
  rows: [
    { Department: "Finance", Groups: "FIN-Users; AAD-KnowBe4" },
    { Department: "Sales", Groups: "SALES-Users" },
  ],
};

test("returns null when the LLM is unavailable / returns nothing", async () => {
  const out = await resolveGroups(sheet, { department: "Finance" }, async () => null);
  assert.equal(out, null);
});

test("validates suggested groups against the sheet; flags hallucinations as unverified", async () => {
  const chat = async () => ({ groups: ["AAD-KnowBe4", "Made-Up-Group"], reasoning: "finance user", lowConfidence: false });
  const out = await resolveGroups(sheet, { department: "Finance" }, chat);
  assert.deepEqual(out!.groups, ["AAD-KnowBe4"]);     // present in a sheet cell
  assert.deepEqual(out!.unverified, ["Made-Up-Group"]); // not in the sheet — surfaced, not trusted
  assert.equal(out!.reasoning, "finance user");
});

test("passes the table + user to the model and carries lowConfidence", async () => {
  let sentUser = "";
  const chat = async (_sys: string, user: string) => {
    sentUser = user;
    return { groups: ["SALES-Users"], lowConfidence: true };
  };
  const out = await resolveGroups(sheet, { department: "Sales", jobTitle: "Rep" }, chat);
  assert.match(sentUser, /SALES-Users/);   // the sheet rows are provided
  assert.match(sentUser, /"department":"Sales"/);
  assert.equal(out!.lowConfidence, true);
  assert.deepEqual(out!.groups, ["SALES-Users"]);
});
