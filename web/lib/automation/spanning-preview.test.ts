import { test } from "node:test";
import assert from "node:assert/strict";
import { previewSpanning } from "./spanning-preview";

test("onboard: assigns a STANDARD backup license", () => {
  const out = previewSpanning("onboard", { assignLicense: true, procureIfUnavailable: true }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /jdoe@acme\.com/);
  assert.match(out, /Set-CtgSpanningLicense/);
  assert.match(out, /STANDARD/);
  assert.match(out, /Procurement Case/);
});

test("onboard: assignLicense=false renders the disabled note, no assign call", () => {
  const out = previewSpanning("onboard", { assignLicense: false }, null, "acme.com");
  assert.match(out, /disabled/);
  assert.doesNotMatch(out, /Set-CtgSpanningLicense/);
});

test("offboard: retains backups and swaps to ARCHIVE", () => {
  const out = previewSpanning("offboard", { swapLicense: { from: "Shared Mailbox", to: "Archive" } }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /never deletes backups/);
  assert.match(out, /ARCHIVE/);
  assert.doesNotMatch(out, /unassign/);
});

test("offboard: removeLicense unassigns instead of swapping", () => {
  const out = previewSpanning("offboard", { removeLicense: true }, null, "acme.com");
  assert.match(out, /\/users\/unassign/);
});

test("null config does not throw", () => {
  assert.ok(previewSpanning("onboard", null, null, "acme.com").length > 10);
});
