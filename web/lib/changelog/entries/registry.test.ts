// The registry is the one thing an author must remember to touch, so it is the one thing that can
// silently drift: an entry file that exists but was never registered simply never appears in the
// change log — no error, no failure, and the PR looks complete. Nothing else would catch it.
//
// This is the same shape of bug as the runner's manifest drift, which took Exchange down fleet-wide
// on 2026-07-16: a function listed in one of two places that must agree, published by neither,
// invisible in review because each file was correct on its own. Two lists that must agree need a
// test that reads both, or they will eventually disagree.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import * as registry from "./_registry";
import { CHANGELOG } from "./index";

const DIR = dirname(fileURLToPath(import.meta.url));

// Every entry lives in <id>.ts; everything else here is machinery.
const entryFiles = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "index.ts" && !f.endsWith(".test.ts"))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort();

const registered = Object.values(registry).map((e) => e.id).sort();

test("every entry file is registered (an unregistered file is silently missing from the log)", () => {
  const unregistered = entryFiles.filter((f) => !registered.includes(f));
  assert.deepEqual(unregistered, [], `entry files not exported from _registry.ts: ${unregistered.join(", ")}`);
});

test("every registered entry has a file, and its id matches the filename", () => {
  // The registry imports by path and the sort/lookup keys off `id`, so a file whose `id` disagrees
  // with its name would register fine yet be impossible to find by the name you see in the tree.
  const orphaned = registered.filter((id) => !entryFiles.includes(id));
  assert.deepEqual(orphaned, [], `registered ids with no matching <id>.ts: ${orphaned.join(", ")}`);
});

test("the registry finds a non-trivial number of entries", () => {
  // Guard the guard: if the glob above ever silently matched nothing, every test here would pass
  // vacuously and the log could empty out without a single failure.
  assert.ok(entryFiles.length > 50, `expected the full history, found ${entryFiles.length} entry files`);
  assert.equal(CHANGELOG.length, entryFiles.length, "CHANGELOG must contain exactly the entry files on disk");
});

test("ids are unique across files (the send API resolves an entry by id)", () => {
  // /api/admin/changelog does CHANGELOG.find(e => e.id === entryId) and posts it to real customer
  // chat channels — a duplicate id would silently send whichever entry happened to be first.
  assert.equal(new Set(registered).size, registered.length, "duplicate entry ids");
});
