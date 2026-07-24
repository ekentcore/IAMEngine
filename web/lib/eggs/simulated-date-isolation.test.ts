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

const ROOTS = ["app", "lib", "middleware.ts"];
const SKIP = new Set(["node_modules", ".next", "generated"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) yield p;
  }
}

test("simulated_date is confined to the eggs preview layer", () => {
  const offenders: string[] = [];
  const cwd = process.cwd(); // npm test runs from web/
  for (const root of ROOTS) {
    let stat; try { stat = statSync(join(cwd, root)); } catch { continue; }
    const files = stat.isDirectory() ? [...walk(join(cwd, root))] : [join(cwd, root)];
    for (const f of files) {
      if (!readFileSync(f, "utf8").includes("simulated_date")) continue;
      const rel = relative(cwd, f);
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `simulated_date leaked outside the eggs layer: ${offenders.join(", ")}`);
});
