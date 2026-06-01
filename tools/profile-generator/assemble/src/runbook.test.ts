import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunbook } from "./runbook.js";
import type { IR } from "./ir.js";

function ir(over: Partial<IR> = {}): IR {
  return {
    irVersion: "1.0",
    client: { leaf: "X", path: "X" },
    kb: { onboard: "KB0001", offboard: "KB0002" },
    actions: ["onboarding"],
    detected: [
      { systemKey: "m365", action: "onboarding", section: "Microsoft 365", seq: 1, confidence: 0.9, mode: "api", steps: ["a", "b"] },
      { systemKey: "hardware", action: "onboarding", section: "Equipment", seq: 0, confidence: 0.9, mode: "manual", steps: ["x"] },
      { systemKey: "exchange", action: "offboarding", section: "Exchange", seq: 5, confidence: 0.9, mode: "api", steps: [] },
    ],
    unmodeled: [{ section: "Box", action: "onboarding", seq: 2, guess: "Box (storage)", steps: ["s1"] }],
    ...over,
  };
}

test("orders onboarding before offboarding, then by seq", () => {
  const items = buildRunbook(ir());
  assert.deepEqual(items.map((i) => i.title), ["Equipment", "Microsoft 365", "Box", "Exchange"]);
});

test("status: api/browser -> automated, manual -> manual, unmodeled -> unmodeled", () => {
  const byTitle = Object.fromEntries(buildRunbook(ir()).map((i) => [i.title, i.status]));
  assert.equal(byTitle["Microsoft 365"], "automated");
  assert.equal(byTitle["Equipment"], "manual");
  assert.equal(byTitle["Box"], "unmodeled");
});

test("attaches the action's KB article number to each item", () => {
  const items = buildRunbook(ir());
  assert.equal(items.find((i) => i.title === "Microsoft 365")!.kbArticle, "KB0001"); // onboarding
  assert.equal(items.find((i) => i.title === "Exchange")!.kbArticle, "KB0002"); // offboarding
});

test("carries steps, systemKey (null for unmodeled), and guess", () => {
  const items = buildRunbook(ir());
  const box = items.find((i) => i.title === "Box")!;
  assert.equal(box.systemKey, null);
  assert.equal(box.guess, "Box (storage)");
  assert.deepEqual(box.steps, ["s1"]);
  assert.equal(items.find((i) => i.title === "Equipment")!.systemKey, "hardware");
});

test("carries artifacts (email templates) onto the item, defaulting to []", () => {
  const email = { type: "email" as const, to: ["hd@x.com"], subject: "New User", body: "Name:", fields: ["Name"] };
  const items = buildRunbook(ir({
    unmodeled: [{ section: "OneMarket", action: "onboarding", seq: 2, guess: null, steps: [], artifacts: [email] }],
  }));
  const om = items.find((i) => i.title === "OneMarket")!;
  assert.deepEqual(om.artifacts, [email]);
  // items without artifacts get an empty array, never undefined
  assert.deepEqual(items.find((i) => i.title === "Microsoft 365")!.artifacts, []);
});
