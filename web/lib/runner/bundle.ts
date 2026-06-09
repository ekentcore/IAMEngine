// Serve the runner/ tree to the one-line installer as a file manifest + per-file fetch (no zip
// dependency, works in any Next runtime). Excludes tests and build artefacts — the host only needs
// the executable modules + Start-IamRunner.ps1. readRunnerFile is path-guarded against traversal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, relative, sep } from "node:path";

export const RUNNER_ROOT = resolve(process.cwd(), "..", "runner");

const SKIP_DIRS = new Set(["tests", "dist", ".git", "node_modules"]);
// Keep this in lockstep with Get-CtgBuildId's skip-list in Start-IamRunner.ps1, or the agent's
// self-computed hash won't match the bundle's. Runtime files (logs, the .build marker) are excluded.
const isSkippedFile = (name: string) => name.endsWith(".Tests.ps1") || name.endsWith(".log") || name === ".DS_Store" || name === ".build";

// All runner files the host needs, as POSIX-style relative paths.
export function listRunnerFiles(dir = RUNNER_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...listRunnerFiles(full));
    } else if (!isSkippedFile(entry)) {
      out.push(relative(RUNNER_ROOT, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

// A deterministic build id for the runner bundle the app currently serves: hash of each file's
// (relpath + content). The runner records the buildId it pulled (in a local .build file) and reports
// it on heartbeat, so the UI can show "up to date" vs "update available" — a real signal, unlike the
// hard-coded version.
//
// Cached, but keyed on the newest runner-file mtime so the cache invalidates whenever a runner file
// changes. A plain process-lifetime cache went stale in dev: a long-running `dev:lan` froze the build
// id at startup, so after committing runner changes the Agents page kept reporting the OLD id (which
// the agent already had) and never showed "update available". Re-stat is cheap; re-hash only on change.
let buildIdCache: { mtimeMs: number; id: string } | null = null;
const NUL = Buffer.from([0]);
export function runnerBuildId(): string {
  const files = listRunnerFiles();
  let newest = 0;
  for (const rel of files) {
    const m = statSync(resolve(RUNNER_ROOT, rel)).mtimeMs;
    if (m > newest) newest = m;
  }
  if (buildIdCache && buildIdCache.mtimeMs === newest) return buildIdCache.id;
  const h = createHash("sha256");
  // Hash RAW BYTES (not decoded text) of each file so the runner's PowerShell computation matches
  // exactly — text decoding diverges on a UTF-8 BOM or line endings, raw bytes don't. Order = the
  // ordinal-sorted POSIX relpaths from listRunnerFiles().
  for (const rel of files) {
    h.update(rel, "utf8");
    h.update(NUL);
    h.update(readFileSync(resolve(RUNNER_ROOT, rel))); // Buffer (raw bytes)
    h.update(NUL);
  }
  const id = h.digest("hex").slice(0, 12);
  buildIdCache = { mtimeMs: newest, id };
  return id;
}

// Read one runner file by its relative path, refusing anything that escapes RUNNER_ROOT.
export function readRunnerFile(relPath: string): string | null {
  const full = resolve(RUNNER_ROOT, relPath);
  if (full !== RUNNER_ROOT && !full.startsWith(RUNNER_ROOT + sep)) return null; // traversal guard
  try {
    if (!statSync(full).isFile()) return null;
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}
