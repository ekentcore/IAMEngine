import test from "node:test";
import assert from "node:assert/strict";
import { parseBuildInfoJson } from "./build-info";

test("parses a full build-info.json into a BuildInfo with a short sha", () => {
  const bi = parseBuildInfoJson(JSON.stringify({
    sha: "0123456789abcdef",
    commitDate: "2026-07-24T13:40:00Z",
    message: "Add deployment status note",
    builtAt: "2026-07-24T13:45:00Z",
  }));
  assert.ok(bi);
  assert.equal(bi!.sha, "0123456789abcdef");
  assert.equal(bi!.shortSha, "0123456");
  assert.equal(bi!.commitDate, "2026-07-24T13:40:00Z");
  assert.equal(bi!.message, "Add deployment status note");
  assert.equal(bi!.source, "file");
});

test("returns null without a sha, so the caller falls through to git", () => {
  assert.equal(parseBuildInfoJson(JSON.stringify({ commitDate: "x" })), null);
  assert.equal(parseBuildInfoJson(JSON.stringify({ sha: "  " })), null);
});

test("returns null on malformed JSON rather than throwing", () => {
  assert.equal(parseBuildInfoJson("{not json"), null);
  assert.equal(parseBuildInfoJson("42"), null);
});

test("tolerates missing optional fields", () => {
  const bi = parseBuildInfoJson(JSON.stringify({ sha: "abcdef1234" }));
  assert.ok(bi);
  assert.equal(bi!.commitDate, null);
  assert.equal(bi!.message, null);
  assert.equal(bi!.builtAt, null);
});
