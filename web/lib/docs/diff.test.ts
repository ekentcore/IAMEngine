import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffStats, collapseUnchanged } from "./diff";

test("diffLines marks added, removed, and unchanged lines", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(d, [
    { type: "same", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "B" },
    { type: "same", text: "c" },
    { type: "add", text: "d" },
  ]);
});

test("diffStats counts adds and removes", () => {
  const s = diffStats(diffLines("a\nb\nc", "a\nB\nc\nd"));
  assert.deepEqual(s, { added: 2, removed: 1 });
});

test("identical text yields all-same and zero stats", () => {
  const d = diffLines("x\ny", "x\ny");
  assert.ok(d.every((l) => l.type === "same"));
  assert.deepEqual(diffStats(d), { added: 0, removed: 0 });
});

test("collapseUnchanged keeps context and inserts a single gap marker", () => {
  const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
  const changed = many.replace("line10", "LINE10");
  const collapsed = collapseUnchanged(diffLines(many, changed), 2);
  // The far-apart unchanged lines collapse to gap markers (same + empty text).
  assert.ok(collapsed.some((l) => l.type === "same" && l.text === ""));
  // The changed line and its neighbours survive.
  assert.ok(collapsed.some((l) => l.type === "add" && l.text === "LINE10"));
  assert.ok(collapsed.some((l) => l.type === "del" && l.text === "line10"));
});
