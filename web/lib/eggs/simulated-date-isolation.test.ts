import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// HARD GUARANTEE (Evan): the date simulator is preview-only. If business logic ever reads
// the simulated_date cookie, a simulated date could trigger real work (e.g. an offboarding
// running early). This test fails the suite the moment the string appears anywhere outside
// the explicit allowlist below.
const ALLOWED = new Set([
  "app/layout.tsx",                              // the single server read site (eggs only)
  "app/_components/eggs/date-simulator.tsx",     // the cookie writer (super-admin UI)
  "lib/eggs/effective-date.ts",                  // the fail-closed override resolver
  "lib/eggs/effective-date.test.ts",
  "lib/eggs/simulated-date-isolation.test.ts",   // this file
]);

const SKIP = new Set(["node_modules", ".next", ".git", "generated"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue; // name check BEFORE statSync — never follow node_modules symlink
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) yield p;
  }
}

test("simulated_date is confined to the eggs preview layer", () => {
  const offenders: string[] = [];
  const scanned: string[] = [];
  const cwd = process.cwd(); // npm test runs from web/
  for (const f of walk(cwd)) {
    const rel = relative(cwd, f);
    scanned.push(rel);
    if (!readFileSync(f, "utf8").includes("simulated_date")) continue;
    if (!ALLOWED.has(rel)) offenders.push(rel);
  }
  // Defeats a vacuous pass (e.g. running with cwd !== web/): prove the scan actually
  // reached the one file guaranteed to contain the string.
  assert.ok(scanned.includes("app/layout.tsx"), "scan did not reach the known read site (app/layout.tsx) — wrong cwd?");
  assert.deepEqual(offenders, [], `simulated_date leaked outside the eggs layer: ${offenders.join(", ")}`);
});
