import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  nextVersion,
  compareVersions,
  changelogSince,
  newestDate,
  parseModelUpdate,
  DOC_BEGIN,
  DOC_END,
  NOTE_PREFIX,
} from "./versioning";
import type { ChangelogEntry } from "@/lib/changelog/entries";

test("parseVersion parses and defaults unparseable to 1.0", () => {
  assert.deepEqual(parseVersion("2.7"), { major: 2, minor: 7 });
  assert.deepEqual(parseVersion(""), { major: 1, minor: 0 });
  assert.deepEqual(parseVersion("v3"), { major: 1, minor: 0 });
  assert.deepEqual(parseVersion(null), { major: 1, minor: 0 });
});

test("nextVersion bumps minor by default and major on request", () => {
  assert.equal(nextVersion("1.0"), "1.1");
  assert.equal(nextVersion("1.9"), "1.10");
  assert.equal(nextVersion("1.4", "major"), "2.0");
  assert.equal(nextVersion(null), "1.1"); // treats missing as 1.0
});

test("compareVersions orders by major then minor", () => {
  assert.ok(compareVersions("2.0", "1.9") > 0);
  assert.ok(compareVersions("1.2", "1.10") < 0);
  assert.equal(compareVersions("1.3", "1.3"), 0);
});

const entries: ChangelogEntry[] = [
  { id: "c", date: "2026-07-15", title: "c", items: ["x"] },
  { id: "b", date: "2026-07-14", title: "b", items: ["y"] },
  { id: "a", date: "2026-07-10", title: "a", items: ["z"] },
];

test("changelogSince returns only entries strictly newer than the cutoff", () => {
  assert.deepEqual(changelogSince(entries, "2026-07-14").map((e) => e.id), ["c"]);
  assert.deepEqual(changelogSince(entries, null).map((e) => e.id), ["c", "b", "a"]);
  assert.deepEqual(changelogSince(entries, "2026-07-15").map((e) => e.id), []);
});

test("newestDate finds the max ISO date, null when empty", () => {
  assert.equal(newestDate(entries), "2026-07-15");
  assert.equal(newestDate([]), null);
});

test("parseModelUpdate slices note + document from sentinels", () => {
  const raw = `${NOTE_PREFIX} Updated the seat-count wording.\n${DOC_BEGIN}\n# Title\n\nBody here.\n${DOC_END}\ntrailing junk`;
  const out = parseModelUpdate(raw);
  assert.equal(out.changeNote, "Updated the seat-count wording.");
  assert.equal(out.markdown, "# Title\n\nBody here.");
});

test("parseModelUpdate falls back to whole text when sentinels are missing", () => {
  const out = parseModelUpdate("# Just a doc\n\nNo markers.");
  assert.equal(out.markdown, "# Just a doc\n\nNo markers.");
  assert.equal(out.changeNote, "");
});
