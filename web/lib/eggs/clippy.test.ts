import { test } from "node:test";
import assert from "node:assert/strict";
import { clippyLine } from "./clippy";

test("clipper has a distinct line for each covered page", () => {
  const routes = ["/cases", "/agents", "/runs", "/changelog", "/clients"];
  const lines = routes.map((r) => clippyLine(r));
  assert.equal(new Set(lines).size, routes.length);
  for (const line of lines) assert.ok(line.startsWith("It looks like"), line);
});

test("subpaths get their section's line", () => {
  assert.equal(clippyLine("/cases/abc123"), clippyLine("/cases"));
  assert.equal(clippyLine("/agents?x=1".split("?")[0]), clippyLine("/agents"));
});

test("unknown pages get the default greeting", () => {
  assert.equal(clippyLine("/"), clippyLine("/settings"));
  assert.ok(clippyLine("/").includes("1997"));
});
