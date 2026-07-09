import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRuleDraft, type ChatFn } from "./nl-rule";

// a fake chat that returns canned JSON (no network) — like group-resolver's injectable chat.
const fake = (obj: Record<string, unknown> | null): ChatFn => async () => obj;

test("group rule: validates the condition + matches the group to the discovered name", async () => {
  const chat = fake({ ruleType: "group", when: "otherNeeds ~= mac|macbook|apple", groups: ["mac user - standard", "Nope Group"], explanation: "Mac users get the Mac Standard group", lowConfidence: false });
  const d = await generateRuleDraft({ text: "add Mac users to Mac User - Standard", kind: "rule", systemKey: "m365", knownGroups: ["Mac User - Standard", "All Users"] }, chat);
  assert.ok(d);
  assert.equal(d!.ruleType, "group");
  assert.equal(d!.conditionValid, true);
  assert.match(d!.condition, /otherNeeds ~= mac/);
  assert.deepEqual(d!.groups!.matched, ["Mac User - Standard"]); // real casing from the known list
  assert.deepEqual(d!.groups!.unmatched, ["Nope Group"]); // flagged, not trusted
});

test("invalid condition from the model is flagged, not silently accepted", async () => {
  const chat = fake({ ruleType: "group", when: "department equals Sales", groups: [], explanation: "x" });
  const d = await generateRuleDraft({ text: "sales people", kind: "rule" }, chat);
  assert.ok(d);
  assert.equal(d!.conditionValid, false);
  assert.match(d!.conditionError ?? "", /Unrecognized condition/);
});

test("OU rule: marks the OU unmatched when it isn't in the discovered list", async () => {
  const chat = fake({ ruleType: "ou", when: "employmentType == Contractor", ou: "OU=Contractors,DC=x", explanation: "contractors OU" });
  const d = await generateRuleDraft({ text: "contractors go in the contractors OU", kind: "rule", knownOus: ["OU=Staff,DC=x"] }, chat);
  assert.equal(d!.ruleType, "ou");
  assert.equal(d!.ou!.path, "OU=Contractors,DC=x");
  assert.equal(d!.ou!.matched, false);
});

test("persona: drafts a match condition, titles and groups", async () => {
  const chat = fake({ ruleType: "persona", personaName: "Field Services", match: "title ~= engineer", titles: ["Field Engineer"], groups: ["Field-Services"], explanation: "engineers", lowConfidence: false });
  const d = await generateRuleDraft({ text: "anyone with engineer in their title; add Field-Services", kind: "persona", knownGroups: ["Field-Services"] }, chat);
  assert.equal(d!.kind, "persona");
  assert.equal(d!.personaName, "Field Services");
  assert.equal(d!.conditionValid, true);
  assert.deepEqual(d!.titles, ["Field Engineer"]);
  assert.deepEqual(d!.groups!.matched, ["Field-Services"]);
});

test("returns null when the chat is unavailable (AI not configured)", async () => {
  const d = await generateRuleDraft({ text: "anything", kind: "rule" }, fake(null));
  assert.equal(d, null);
});

test("a correction passes the current draft + correction to the model", async () => {
  let captured = "";
  const chat: ChatFn = async (_sys, user) => { captured = user; return { ruleType: "group", when: "otherNeeds ~= mac && country.code == US", groups: ["Mac User - Standard"], explanation: "US mac" }; };
  const current = (await generateRuleDraft({ text: "mac users", kind: "rule", knownGroups: ["Mac User - Standard"] }, fake({ ruleType: "group", when: "otherNeeds ~= mac", groups: ["Mac User - Standard"], explanation: "mac" })))!;
  const d = await generateRuleDraft({ text: "mac users", kind: "rule", knownGroups: ["Mac User - Standard"], current, correction: "only US-based" }, chat);
  assert.match(captured, /only US-based/);
  assert.match(d!.condition, /country\.code == US/);
});
