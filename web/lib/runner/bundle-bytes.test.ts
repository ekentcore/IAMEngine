import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { listRunnerFiles } from "./bundle";

const REPO = resolve(import.meta.dirname, "../../..");
const RUNNER = resolve(REPO, "runner");

// The app serves these files straight off disk and the build id is a SHA-256 over their raw bytes,
// which the agent recomputes over its own copy to decide whether it is up to date. So the bytes on
// disk ARE the contract, and they have to be a property of the commit -- not of whoever checked it
// out. On a Windows checkout with core.autocrlf=true they were not: git stored LF and materialised
// CRLF, so any tool that wrote a file with LF moved the build id without changing a line of code,
// and the next `git checkout` moved it back. Both directions told the whole fleet to self-update,
// and a self-update EXITS the runner process. `runner/** text eol=lf` in .gitattributes pins it.
test("no file in the runner bundle contains a carriage return", () => {
  const offenders = listRunnerFiles().filter((rel) => readFileSync(resolve(RUNNER, rel)).includes(0x0d));
  assert.deepEqual(
    offenders,
    [],
    "CRLF in the runner bundle makes the build id depend on the checkout rather than the commit. " +
      'Check .gitattributes still carries "runner/** text eol=lf", then re-materialise: ' +
      "git ls-files -z runner/ | xargs -0 rm -f && git checkout -- runner/ . " +
      `offenders: ${offenders.join(", ")}`,
  );
});

// The invariant the above protects, stated directly: a file nobody has edited must be on disk
// exactly as it is committed. If a checkout can alter bytes, two app instances on different
// checkouts serve different build ids for the same commit and agents flap between them forever.
//
// Only UNMODIFIED files are compared. A file with real edits in the working tree is supposed to
// differ from HEAD -- that is what editing is -- and failing on it would make this test red for
// anyone mid-change, which is the fastest way to get a test deleted.
test("every unmodified bundle file on disk is byte-identical to the committed version", () => {
  const status = execFileSync("git", ["status", "--porcelain", "--", "runner/"], { cwd: REPO, encoding: "utf8" });
  const dirty = new Set(
    status
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, "").replace(/^runner\//, "")),
  );
  const differing: string[] = [];
  for (const rel of listRunnerFiles()) {
    if (dirty.has(rel)) continue;
    const committed = execFileSync("git", ["show", `HEAD:runner/${rel}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    if (!committed.equals(readFileSync(resolve(RUNNER, rel)))) differing.push(rel);
  }
  assert.deepEqual(
    differing,
    [],
    "these files are unedited yet differ from HEAD, so the checkout itself changed their bytes -- " +
      'almost certainly line endings. Check .gitattributes still carries "runner/** text eol=lf". ' +
      `differing: ${differing.join(", ")}`,
  );
});
