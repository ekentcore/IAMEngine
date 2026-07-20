// Parity guard: web/lib/secrets/graph-caps.ts and runner/Start-IamRunner.ps1 each hand-maintain the
// SAME capability table (the runner can't import TypeScript, the app can't import PowerShell). When
// they drift, the runner's surplus scan flags a web-known permission as "not needed" — rendered red,
// read as MISSING by operators (core1787: a granted MailboxSettings.Read reported as a gap). This
// test fails the moment a web cap (its need text or any of its roles) is absent from the runner copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GRAPH_REQUIRED_CAPS, GRAPH_OPTIONAL_CAPS } from "./graph-caps";

// Tests run from web/ (npm test), so the runner script sits one level up.
const RUNNER_PS1 = resolve(process.cwd(), "../runner/Start-IamRunner.ps1");

test("every web Graph capability (need + roles) exists in the runner's capability table", () => {
  const ps1 = readFileSync(RUNNER_PS1, "utf8");
  for (const cap of [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS]) {
    assert.ok(ps1.includes(cap.need), `runner is missing the capability "${cap.need}" — sync $GRAPH_OPTIONAL_CAPS/$GRAPH_REQUIRED_CAPS in Start-IamRunner.ps1 (and bump runner/VERSION)`);
    for (const role of cap.anyOf) {
      assert.ok(ps1.includes(role), `runner's copy of "${cap.need}" is missing role ${role}`);
    }
  }
});
