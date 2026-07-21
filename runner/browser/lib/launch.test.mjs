import { test } from "node:test";
import assert from "node:assert/strict";
import { deHeadlessUserAgent } from "./launch.mjs";

test("deHeadlessUserAgent: swaps the HeadlessChrome token, preserving platform + version", () => {
  const headless = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36";
  const fixed = deHeadlessUserAgent(headless);
  assert.equal(fixed, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36");
  assert.ok(!fixed.includes("HeadlessChrome"));
  assert.ok(fixed.includes("149.0.0.0")); // version preserved
});

test("deHeadlessUserAgent: preserves a Linux/Windows platform token (fleet is not all Mac)", () => {
  const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36";
  assert.match(deHeadlessUserAgent(linux), /X11; Linux x86_64/);
  const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36";
  assert.match(deHeadlessUserAgent(win), /Windows NT 10\.0/);
});

test("deHeadlessUserAgent: returns null when there is nothing to change (leave the default UA)", () => {
  assert.equal(deHeadlessUserAgent("Mozilla/5.0 ... Chrome/149.0.0.0 Safari/537.36"), null);
  assert.equal(deHeadlessUserAgent(""), null);
  assert.equal(deHeadlessUserAgent(undefined), null);
  assert.equal(deHeadlessUserAgent(null), null);
});
