import { test } from "node:test";
import assert from "node:assert/strict";
import { findSpanningToken, scrubSpanningToken } from "./spanning-harvest";

test("findSpanningToken deep-finds the harvested API token under common key spellings", () => {
  assert.deepEqual(findSpanningToken({ Credentials: { apiToken: "abc123def456" } }), { apiToken: "abc123def456" });
  assert.deepEqual(findSpanningToken({ result: { data: { ApiKey: "k-9988776655" } } }), { apiToken: "k-9988776655" });
  assert.deepEqual(findSpanningToken({ token: "tok-1234567890" }), { apiToken: "tok-1234567890" });
});

test("findSpanningToken captures the sibling username (the console's msUserPrincipalName)", () => {
  assert.deepEqual(
    findSpanningToken({ Credentials: { apiToken: "abc123def456", username: "coretelligent@willowridge.com" } }),
    { apiToken: "abc123def456", username: "coretelligent@willowridge.com" },
  );
  assert.deepEqual(
    findSpanningToken({ token: "tok-1234567890", msUserPrincipalName: "admin@x.com" }),
    { apiToken: "tok-1234567890", username: "admin@x.com" },
  );
  // No username sibling -> token only, no username key.
  assert.deepEqual(findSpanningToken({ apiToken: "abc123def456" }), { apiToken: "abc123def456" });
});

test("findSpanningToken returns null when no token present", () => {
  assert.equal(findSpanningToken({ System: "spanning-console-setup", Status: "ok", Actions: ["did a thing"] }), null);
  assert.equal(findSpanningToken(null), null);
  assert.equal(findSpanningToken("nope"), null);
});

test("scrubSpanningToken strips the token keys and marks the result scrubbed", () => {
  const out = scrubSpanningToken({ System: "x", Credentials: { apiToken: "SECRET" }, apiKey: "SECRET2", keep: "yes" }) as Record<string, unknown>;
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
  assert.equal(out._harvestScrubbed, true);
  assert.equal(out.keep, "yes");
  assert.equal(findSpanningToken(out), null); // nothing harvestable remains
});
