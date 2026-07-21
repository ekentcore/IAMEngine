import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { notM365AutoSetupCase, M365_AUTOSETUP_MARKER, GOOGLE_AUTOSETUP_MARKER } from "./exclude-m365-autosetup";

// Regression guard for the PR #131 outage: a bare `NOT: { payload: { path, equals: true } }` filter
// drops EVERY case whose payload lacks the marker key (JSON path → SQL NULL, NOT NULL → NULL → not
// matched), which emptied the entire /cases queue. The correct filter must ALSO keep the null-path
// rows. These tests fail if someone ever "simplifies" it back to the broken single-NOT form.
//
// Widened for Task 6 (google browser-job dispatch, PR TBD): the helper now also hides cases marked
// googleAutoSetup, via an AND of two per-marker branches — each branch preserves the EXACT
// OR-with-DbNull shape the outage fix required, just once per marker, so neither marker's exclusion
// can regress to the broken bare-NOT form.

test("marker key is the one dispatch-device-code-job writes", () => {
  assert.equal(M365_AUTOSETUP_MARKER, "m365AutoSetup");
});

test("google marker key is the one dispatch-google-browser-job writes", () => {
  assert.equal(GOOGLE_AUTOSETUP_MARKER, "googleAutoSetup");
});

test("filter is an AND of per-marker OR branches, each with the null-path branch (not a bare NOT)", () => {
  const and = notM365AutoSetupCase.AND;
  assert.ok(Array.isArray(and), "must be an AND of per-marker branches");
  assert.equal(and.length, 2);

  for (const branch of and) {
    const or = (branch as { OR?: Prisma.CaseRequestWhereInput[] }).OR;
    assert.ok(Array.isArray(or), "each marker branch must itself be an OR of two sub-branches");
    assert.equal(or.length, 2);

    const hasNotEqualsTrue = or.some(
      (b) => b.NOT && (b.NOT as { payload?: { equals?: unknown } }).payload?.equals === true
    );
    // The critical branch the outage was missing: rows whose JSON path resolves to SQL NULL
    // (payload has no marker key at all) must be explicitly kept.
    const hasNullPathBranch = or.some(
      (b) => (b.payload as { equals?: unknown } | undefined)?.equals === Prisma.DbNull
    );

    assert.ok(hasNotEqualsTrue, "must exclude payloads where the marker equals true");
    assert.ok(hasNullPathBranch, "must keep rows whose marker path is NULL (key absent)");
  }
});

test("the two AND branches target the m365 marker and the google marker respectively", () => {
  const and = notM365AutoSetupCase.AND as Prisma.CaseRequestWhereInput[];
  const pathsPerBranch = and.map((branch) => {
    const or = (branch as { OR?: Prisma.CaseRequestWhereInput[] }).OR ?? [];
    const paths = or.flatMap((b) => {
      const p1 = (b.NOT as { payload?: { path?: string[] } } | undefined)?.payload?.path;
      const p2 = (b.payload as { path?: string[] } | undefined)?.path;
      return [p1, p2].filter(Boolean) as string[][];
    });
    assert.ok(paths.length >= 2);
    for (const p of paths) assert.deepEqual(p, paths[0]); // both sub-branches target the same marker
    return paths[0];
  });
  assert.deepEqual(
    pathsPerBranch.sort(),
    [[GOOGLE_AUTOSETUP_MARKER], [M365_AUTOSETUP_MARKER]].sort()
  );
});

// Functional regression checks: exercise the actual filter shape against representative payloads,
// the way Prisma's JSON filtering would (NOT+equals:true excludes marker===true; the DbNull branch
// keeps rows where the key is absent). This guards the AND-of-ORs composition itself, not just its
// shape.
//
// NOTE: this interpreter's `NOT` (line below: `!evaluate(...)`) implements plain boolean NOT, not
// Prisma/SQL's tri-valued NULL logic — so it CANNOT reproduce the PR #131 outage on its own (a bare
// `NOT: { payload: { path, equals: true } }` here would just evaluate to `!false` = `true` for an
// absent key, i.e. "kept", masking the bug this suite exists to catch). The real regression guard is
// the structural shape assertions above (asserting the OR-with-DbNull-branch shape is present at
// all) — they fail if the bare-NOT form ever comes back, regardless of what this interpreter would
// compute for it.
function evaluate(where: Prisma.CaseRequestWhereInput, payload: Record<string, unknown>): boolean {
  if (where.AND) return (where.AND as Prisma.CaseRequestWhereInput[]).every((w) => evaluate(w, payload));
  if (where.OR) return (where.OR as Prisma.CaseRequestWhereInput[]).some((w) => evaluate(w, payload));
  if (where.NOT) return !evaluate(where.NOT as Prisma.CaseRequestWhereInput, payload);
  const jsonFilter = where.payload as { path?: string[]; equals?: unknown } | undefined;
  if (jsonFilter?.path) {
    const key = jsonFilter.path[0];
    const present = Object.prototype.hasOwnProperty.call(payload, key);
    if (jsonFilter.equals === Prisma.DbNull) return !present;
    if (!present) return false; // JSON path resolves to SQL NULL -> comparison is unmatched
    return payload[key] === jsonFilter.equals;
  }
  return true;
}

test("a normal case (neither marker present) is kept", () => {
  assert.equal(evaluate(notM365AutoSetupCase, { someIntakeField: "x" }), true);
});

test("an m365AutoSetup case is still hidden", () => {
  assert.equal(evaluate(notM365AutoSetupCase, { [M365_AUTOSETUP_MARKER]: true }), false);
});

test("a googleAutoSetup case is hidden", () => {
  assert.equal(evaluate(notM365AutoSetupCase, { [GOOGLE_AUTOSETUP_MARKER]: true }), false);
});
