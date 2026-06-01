import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEml, emlFilename } from "./eml";
import type { EmailArtifact } from "./artifacts";

const onemarket: EmailArtifact = {
  type: "email",
  to: ["helpdesk@logicsource.com", "s2chelp@logicsource.com"],
  cc: ["Scotty Forrest", "help@core.tech"],
  subject: "New User Activation: OneMarket Apps",
  body: "Good morning,\n\nName:\nTitle:\n\nThank you,",
  fields: ["Name", "Title"],
};

test("To/Cc/Subject headers use only valid addresses", () => {
  const eml = buildEml(onemarket);
  assert.match(eml, /^To: helpdesk@logicsource\.com, s2chelp@logicsource\.com$/m);
  assert.match(eml, /^Cc: help@core\.tech$/m); // "Scotty Forrest" is not an address — excluded from Cc header
  assert.match(eml, /^Subject: New User Activation: OneMarket Apps$/m);
});

test("name-only CC recipients are surfaced in the body, not dropped", () => {
  const eml = buildEml(onemarket);
  assert.match(eml, /Scotty Forrest/); // a reminder to CC the person manually
});

test("is RFC-822 with CRLF line endings and a blank line before the body", () => {
  const eml = buildEml(onemarket);
  assert.ok(eml.includes("\r\n\r\n"), "blank line separates headers from body");
  assert.match(eml, /Content-Type: text\/plain; charset=utf-8/);
  assert.ok(eml.trimEnd().endsWith("Thank you,"));
});

test("no Cc header when there are no address-form CCs", () => {
  const eml = buildEml({ ...onemarket, cc: ["Scotty Forrest"] });
  assert.doesNotMatch(eml, /^Cc:/m);
});

test("emlFilename slugifies the subject and ends with .eml", () => {
  assert.equal(emlFilename("logicsource-inc", onemarket), "logicsource-inc-new-user-activation-onemarket-apps.eml");
  assert.equal(emlFilename("x", { ...onemarket, subject: "" }), "x-email.eml");
});
