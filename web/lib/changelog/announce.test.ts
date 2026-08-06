import { test } from "node:test";
import assert from "node:assert/strict";
import { changelogAnnouncement } from "./announce";
import type { ChangelogEntry } from "./format";

const entry: ChangelogEntry = {
  id: "example",
  date: "2026-08-06",
  time: "12:00",
  title: "A thing shipped",
  items: ["first bullet", "second bullet"],
};

test("the title names the entry, so the room can tell two sends apart", () => {
  assert.equal(changelogAnnouncement(entry).title, "iam-engine update — A thing shipped");
});

test("bullets are rendered one per line, prefixed", () => {
  const { detail } = changelogAnnouncement(entry);
  const lines = detail.split("\n");
  assert.ok(lines.includes("• first bullet"));
  assert.ok(lines.includes("• second bullet"));
});

test("the ship time is stated", () => {
  assert.match(changelogAnnouncement(entry).detail, /^Shipped: /m);
});

test("a comment leads, separated from the entry by a blank line", () => {
  const { detail } = changelogAnnouncement(entry, "automatic update by Claude AI");
  const lines = detail.split("\n");
  assert.equal(lines[0], "automatic update by Claude AI");
  assert.equal(lines[1], "", "a blank line separates the note from the entry");
  assert.match(lines[2], /^Shipped: /);
});

test("no comment means no leading blank line — never a dangling separator", () => {
  for (const c of [undefined, null, "", "   "]) {
    const { detail } = changelogAnnouncement(entry, c);
    assert.match(detail.split("\n")[0], /^Shipped: /, `empty comment ${JSON.stringify(c)} still leads with Shipped`);
  }
});

test("a comment is trimmed, so a pasted trailing newline can't open a gap", () => {
  const { detail } = changelogAnnouncement(entry, "  padded note \n");
  assert.equal(detail.split("\n")[0], "padded note");
});
