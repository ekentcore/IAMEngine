import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_EGGS, EGG_CATALOG } from "./catalog";
import { EGG_DEMOS } from "@/app/easter-eggs/_components/egg-demos";

// The /easter-eggs cards are clickable only when a demo is registered — a live egg without one
// would silently render an inert card. New egg ⇒ new demo, in the same PR.
test("every live egg has a demo", () => {
  for (const egg of LIVE_EGGS) {
    assert.ok(EGG_DEMOS[egg.slug], `live egg "${egg.slug}" has no demo in EGG_DEMOS`);
  }
});

test("every demo points at a cataloged egg", () => {
  const slugs = new Set(EGG_CATALOG.map((e) => e.slug));
  for (const slug of Object.keys(EGG_DEMOS)) {
    assert.ok(slugs.has(slug), `demo "${slug}" has no catalog entry`);
  }
});

test("demos declare a valid kind", () => {
  for (const [slug, demo] of Object.entries(EGG_DEMOS)) {
    assert.ok(demo.kind === "inline" || demo.kind === "takeover", slug);
    assert.equal(typeof demo.render, "function", slug);
  }
});
