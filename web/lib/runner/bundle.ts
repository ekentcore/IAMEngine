// Serve the runner/ tree to the one-line installer as a file manifest + per-file fetch (no zip
// dependency, works in any Next runtime). Excludes tests and build artefacts — the host only needs
// the executable modules + Start-IamRunner.ps1. readRunnerFile is path-guarded against traversal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

export const RUNNER_ROOT = resolve(process.cwd(), "..", "runner");

const SKIP_DIRS = new Set(["tests", "dist", ".git", "node_modules"]);
const isSkippedFile = (name: string) => name.endsWith(".Tests.ps1") || name === ".DS_Store";

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
