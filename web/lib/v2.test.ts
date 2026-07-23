import { test } from "node:test";
import assert from "node:assert/strict";
import { readSiteVersion, resolveVersionedPath, counterpartPath } from "./v2";

test("readSiteVersion defaults to v2 and only 'v3' opts up", () => {
  assert.equal(readSiteVersion(undefined), "v2");
  assert.equal(readSiteVersion(""), "v2");
  assert.equal(readSiteVersion("v2"), "v2");
  assert.equal(readSiteVersion("v3"), "v3");
  // A legacy site_v2=on value is meaningless now — treated as v2, never v3.
  assert.equal(readSiteVersion("on"), "v2");
});

test("v1 is retired: the bare canonical path always resolves away from v1", () => {
  assert.equal(resolveVersionedPath("/cases", "v2"), "/cases/v2");
  assert.equal(resolveVersionedPath("/cases", "v3"), "/cases/v3");
  assert.equal(resolveVersionedPath("/clients", "v2"), "/clients/v2");
  assert.equal(resolveVersionedPath("/clients", "v3"), "/clients/v3");
});

test("the slider routes between v2 and v3", () => {
  // On a v2 route
  assert.equal(resolveVersionedPath("/cases/v2", "v2"), "/cases/v2"); // stay
  assert.equal(resolveVersionedPath("/cases/v2", "v3"), "/cases/v3"); // up to v3
  // On a v3 route
  assert.equal(resolveVersionedPath("/cases/v3", "v3"), "/cases/v3"); // stay
  assert.equal(resolveVersionedPath("/cases/v3", "v2"), "/cases/v2"); // back to v2
});

test("non-versioned paths (detail pages, sub-routes, APIs) are left untouched", () => {
  assert.equal(resolveVersionedPath("/cases/abc123", "v3"), null);
  assert.equal(resolveVersionedPath("/clients/acme-co", "v3"), null);
  assert.equal(resolveVersionedPath("/api/cases", "v3"), null);
  assert.equal(resolveVersionedPath("/", "v3"), null);
});

test("the /health/connections sub-path has its own family and isn't shadowed by /health", () => {
  assert.equal(resolveVersionedPath("/health", "v3"), "/health/v3");
  assert.equal(resolveVersionedPath("/health/connections", "v3"), "/health/connections/v3");
  assert.equal(resolveVersionedPath("/health/connections/v2", "v3"), "/health/connections/v3");
});

test("counterpartPath returns the jump target for the toggle, or null when already there", () => {
  assert.equal(counterpartPath("/cases/v2", "v3"), "/cases/v3");
  assert.equal(counterpartPath("/cases/v3", "v2"), "/cases/v2");
  assert.equal(counterpartPath("/cases/v3", "v3"), null); // already on v3
  assert.equal(counterpartPath("/cases/abc123", "v3"), null); // detail page, nothing to jump to
});
