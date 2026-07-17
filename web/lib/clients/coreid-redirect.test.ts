import { test } from "node:test";
import assert from "node:assert/strict";
import { findClientByCoreIdSlug } from "./coreid-redirect";

// Minimal db stub: one client keyed by its canonical coreId. findUnique({ where: { coreId } }) is the
// only call the resolver makes.
function db(row: { id: string; slug: string; coreId: string } | null) {
  const calls = { coreIds: [] as string[] };
  return {
    calls,
    db: {
      client: {
        findUnique: async ({ where }: { where: { coreId: string } }) => {
          calls.coreIds.push(where.coreId);
          return row && row.coreId === where.coreId ? { id: row.id, slug: row.slug } : null;
        },
      },
    } as any,
  };
}

const yuma = { id: "c1", slug: "yuma", coreId: "CORE1955" };

test("resolves a CORE-id segment to the client's id + canonical name slug", async () => {
  const { db: d, calls } = db(yuma);
  assert.deepEqual(await findClientByCoreIdSlug(d, "core1955"), { id: "c1", canonicalSlug: "yuma" });
  assert.deepEqual(calls.coreIds, ["CORE1955"]); // normalized before the lookup
});

test("normalizes assorted CORE-id spellings", async () => {
  for (const seg of ["CORE1955", "core-1955", "core 1955", "1955"]) {
    const { db: d } = db(yuma);
    assert.deepEqual(await findClientByCoreIdSlug(d, seg), { id: "c1", canonicalSlug: "yuma" }, `for "${seg}"`);
  }
});

test("returns null for a non-CORE-id segment without touching the db", async () => {
  const { db: d, calls } = db(yuma);
  assert.equal(await findClientByCoreIdSlug(d, "not-a-core-id"), null);
  assert.deepEqual(calls.coreIds, []);
});

test("returns null when no client owns that CORE id", async () => {
  const { db: d } = db(null);
  assert.equal(await findClientByCoreIdSlug(d, "core9999"), null);
});

test("returns null when the requested slug already equals the canonical slug", async () => {
  // A client whose slug IS its lowercased coreid (the common case) — no alias to honour, so no
  // needless redirect-to-self.
  const { db: d } = db({ id: "c2", slug: "core1028", coreId: "CORE1028" });
  assert.equal(await findClientByCoreIdSlug(d, "core1028"), null);
});
