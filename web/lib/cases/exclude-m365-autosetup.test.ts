import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { notM365AutoSetupCase, M365_AUTOSETUP_MARKER } from "./exclude-m365-autosetup";

// Regression guard for the PR #131 outage: a bare `NOT: { payload: { path, equals: true } }` filter
// drops EVERY case whose payload lacks the marker key (JSON path → SQL NULL, NOT NULL → NULL → not
// matched), which emptied the entire /cases queue. The correct filter must ALSO keep the null-path
// rows. These tests fail if someone ever "simplifies" it back to the broken single-NOT form.

test("marker key is the one dispatch-device-code-job writes", () => {
  assert.equal(M365_AUTOSETUP_MARKER, "m365AutoSetup");
});

test("filter is an OR that includes the null-path branch (not a bare NOT)", () => {
  const or = notM365AutoSetupCase.OR;
  assert.ok(Array.isArray(or), "must be an OR of branches, not a lone NOT");
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
});

test("the marker path targets the shared marker key", () => {
  const paths = (notM365AutoSetupCase.OR ?? []).flatMap((b) => {
    const p1 = (b.NOT as { payload?: { path?: string[] } } | undefined)?.payload?.path;
    const p2 = (b.payload as { path?: string[] } | undefined)?.path;
    return [p1, p2].filter(Boolean) as string[][];
  });
  assert.ok(paths.length >= 2);
  for (const p of paths) assert.deepEqual(p, [M365_AUTOSETUP_MARKER]);
});
