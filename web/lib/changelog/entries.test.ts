import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANGELOG } from "./entries";

test("change-log entries are well-formed (unique ids, valid dates, newest first, non-empty items)", () => {
  assert.ok(CHANGELOG.length > 0);
  const ids = new Set<string>();
  let prev: string | null = null;
  for (const e of CHANGELOG) {
    assert.ok(e.id && !ids.has(e.id), `duplicate/empty id: ${e.id}`);
    ids.add(e.id);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `bad date on ${e.id}`);
    assert.ok(!Number.isNaN(new Date(e.date).getTime()), `unparseable date on ${e.id}`);
    assert.ok(e.title.trim().length > 0, `empty title on ${e.id}`);
    assert.ok(e.items.length > 0 && e.items.every((i) => i.trim().length > 0), `empty items on ${e.id}`);
    // Bullets go to chat verbatim as single lines.
    assert.ok(e.items.every((i) => !i.includes("\n")), `multiline item on ${e.id}`);
    if (prev) assert.ok(e.date <= prev, `entries out of order at ${e.id} (newest must be first)`);
    prev = e.date;
  }
});
