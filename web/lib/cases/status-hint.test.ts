import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCaseStatusHint } from "./repository";

const name = (k: string) => ({ "active-directory": "Active Directory", m365: "Microsoft 365", servicenow: "ServiceNow" }[k] ?? k);
const job = (o: Partial<{ systemKey: string; sequence: number; status: string; mode: string; error: string | null; request: unknown }>) => ({
  systemKey: o.systemKey ?? "m365", sequence: o.sequence ?? 0, status: o.status ?? "pending",
  mode: o.mode ?? "api", error: o.error ?? null, request: (o.request ?? {}) as never,
});

test("failed: surfaces the failed step + its error", () => {
  const h = buildCaseStatusHint("failed", [job({ systemKey: "active-directory", status: "failed", error: "Authentication failed" })], name, true);
  assert.match(h, /Active Directory failed: Authentication failed/);
});

test("needs_manual: names the manual steps and says why", () => {
  const h = buildCaseStatusHint("needs_manual", [job({ systemKey: "servicenow", mode: "manual", status: "manual" })], name, true);
  assert.match(h, /Manual step/);
  assert.match(h, /ServiceNow/);
});

test("queued: blocked reports the predecessor it's waiting on", () => {
  const jobs = [
    job({ systemKey: "active-directory", sequence: 0, status: "running" }),
    job({ systemKey: "m365", sequence: 1, status: "pending" }),
  ];
  const h = buildCaseStatusHint("queued", jobs, name, true);
  assert.match(h, /Waiting on Active Directory to finish before Microsoft 365/);
});

test("queued: ready but no runner online says so", () => {
  const h = buildCaseStatusHint("queued", [job({ systemKey: "active-directory", sequence: 0, status: "pending" })], name, false);
  assert.match(h, /no runner is online/i);
});

test("queued: ready with a runner online", () => {
  const h = buildCaseStatusHint("queued", [job({ systemKey: "active-directory", sequence: 0, status: "pending" })], name, true);
  assert.match(h, /waiting for a runner to claim Active Directory/i);
});

test("queued: a missing required secret blocks and is named first", () => {
  const h = buildCaseStatusHint("queued", [job({ systemKey: "active-directory", sequence: 0, status: "pending" })], name, true, ["ad-dc"]);
  assert.match(h, /Blocked — credential not set: ad-dc/);
});

test("needs_approval: names the gated step", () => {
  const h = buildCaseStatusHint("needs_approval", [job({ systemKey: "active-directory", status: "pending", request: { requiresApproval: true } })], name, true);
  assert.match(h, /Waiting for approval on: Active Directory/);
});

test("completed / running are described", () => {
  assert.match(buildCaseStatusHint("completed", [], name, true), /all steps done/);
  assert.match(buildCaseStatusHint("running", [job({ status: "dispatched" })], name, true), /Running: Microsoft 365/);
});
