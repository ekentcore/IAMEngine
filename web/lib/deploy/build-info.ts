// What commit is THIS running server built from? Two sources, in order:
//   1. build-info.json at the repo root — written by CI into the Docker build context before the
//      image is built (the container has no .git, so this baked file is the only reliable source in
//      production). Resolved at <cwd>/../build-info.json (cwd is /app/web in the container).
//   2. the local .git — for `next dev`/`start` run from a checkout, where no build-info.json exists.
//      Shells out to git (fast, guarded, dev-only in practice); tolerates git being absent.
// If neither works, source is "unknown" and the UI says the build didn't record its commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BuildInfo = {
  sha: string | null;
  shortSha: string | null;
  commitDate: string | null; // ISO-8601 of the commit (author/committer date)
  message: string | null; // first line of the commit message
  builtAt: string | null; // ISO-8601 when CI built the image (file source only)
  source: "file" | "git" | "unknown";
};

const UNKNOWN: BuildInfo = { sha: null, shortSha: null, commitDate: null, message: null, builtAt: null, source: "unknown" };

// Parse a build-info.json payload into a BuildInfo. Exported for tests. Returns null when the blob
// isn't usable (bad JSON, or no sha) so the caller can fall through to the git source.
export function parseBuildInfoJson(raw: string): BuildInfo | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const sha = typeof o.sha === "string" && o.sha.trim() ? o.sha.trim() : null;
  if (!sha) return null;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    commitDate: typeof o.commitDate === "string" ? o.commitDate : null,
    message: typeof o.message === "string" ? o.message : null,
    builtAt: typeof o.builtAt === "string" ? o.builtAt : null,
    source: "file",
  };
}

function fromFile(): BuildInfo | null {
  const path = resolve(process.cwd(), "..", "build-info.json");
  if (!existsSync(path)) return null;
  try {
    return parseBuildInfoJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || null;
  } catch {
    return null; // no git binary, or not a repo (the container) — fall through to unknown
  }
}

function fromGit(): BuildInfo | null {
  const sha = git(["rev-parse", "HEAD"]);
  if (!sha) return null;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    commitDate: git(["show", "-s", "--format=%cI", "HEAD"]),
    message: git(["show", "-s", "--format=%s", "HEAD"]),
    builtAt: null,
    source: "git",
  };
}

// Resolved once per process — the running build's commit can't change under a live process.
let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  cached = fromFile() ?? fromGit() ?? UNKNOWN;
  return cached;
}
