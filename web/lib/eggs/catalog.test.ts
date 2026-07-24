import { test } from "node:test";
import assert from "node:assert/strict";
import { EGG_CATALOG, LIVE_EGGS, IDEA_EGGS, canViewEggCatalog } from "./catalog";
import type { Role } from "@prisma/client";
import { ROLE_RANK } from "@/lib/auth/permissions";

test("only the real super_admin may view the egg catalog", () => {
  for (const role of Object.keys(ROLE_RANK) as Role[]) {
    assert.equal(canViewEggCatalog(role), role === "super_admin", role);
  }
  assert.equal(canViewEggCatalog(null), false);
  assert.equal(canViewEggCatalog(undefined), false);
});

test("catalog slugs are unique", () => {
  const slugs = EGG_CATALOG.map((e) => e.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("every entry is fully described", () => {
  for (const egg of EGG_CATALOG) {
    for (const field of ["slug", "name", "emoji", "where", "trigger", "description"] as const) {
      assert.ok(egg[field].trim().length > 0, `${egg.slug}.${field} is empty`);
    }
    assert.ok(egg.status === "live" || egg.status === "idea", egg.slug);
  }
});

test("live/idea splits cover the whole catalog", () => {
  assert.equal(LIVE_EGGS.length + IDEA_EGGS.length, EGG_CATALOG.length);
  assert.ok(LIVE_EGGS.every((e) => e.status === "live"));
  assert.ok(IDEA_EGGS.every((e) => e.status === "idea"));
  // The shipped inventory: 24 live eggs — 14 from the first batches (specs 1-12 + day-of
  // greetings + pirate) plus the ten-egg batch. If you ship or add one, update the catalog AND
  // these counts in the same PR.
  assert.equal(LIVE_EGGS.length, 24);
  assert.equal(IDEA_EGGS.length, 0);
});
