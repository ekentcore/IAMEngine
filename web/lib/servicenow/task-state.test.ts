import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskState } from "./task-state";

test("resolved/closed/complete states count as done", () => {
  assert.equal(classifyTaskState("Resolved"), "done");
  assert.equal(classifyTaskState("Closed"), "done");
  assert.equal(classifyTaskState("Closed Complete"), "done");
});

test("cancelled never counts as done — even 'Closed Cancelled'", () => {
  assert.equal(classifyTaskState("Cancelled"), "cancelled");
  assert.equal(classifyTaskState("Closed Cancelled"), "cancelled");
});

test("closed-without-doing-the-work states are NOT done", () => {
  assert.equal(classifyTaskState("Closed Incomplete"), "cancelled");
  assert.equal(classifyTaskState("Closed Skipped"), "cancelled");
});

test("working states stay open", () => {
  assert.equal(classifyTaskState("New"), "open");
  assert.equal(classifyTaskState("In Progress"), "open");
  assert.equal(classifyTaskState("On Hold"), "open");
});
