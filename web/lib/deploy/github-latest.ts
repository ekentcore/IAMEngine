// Fetches the latest commit on the tracked GitHub branch (default ekentcore/IAMEngine@main) and, when
// the running build differs, how many commits behind it is (the compare API's behind_by). Server-side
// only. The repo is PUBLIC, so no token is needed — but the unauthenticated GitHub API allows only
// 60 requests/hour per egress IP, so results are cached in-module (default 5 min). On any error
// (rate limit, offline, unexpected shape) it returns the last good result if still cached, else an
// error result — it NEVER throws, so it can't take the Settings page down.

export type GhCommit = { sha: string; shortSha: string; date: string | null; message: string | null };
export type LatestResult = {
  latest: GhCommit | null;
  behindBy: number | null;
  repo: string;
  branch: string;
  fetchedAt: string; // ISO of when this (fresh or cached) result was produced
  error: string | null;
};

export const GITHUB_REPO = process.env.GITHUB_REPO || "ekentcore/IAMEngine";
export const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const TTL_MS = Number(process.env.GITHUB_LATEST_TTL_MS ?? 5 * 60_000);
const API = "https://api.github.com";

type Deps = { fetch: typeof fetch; now: () => number };
const firstLine = (m: unknown) => (typeof m === "string" ? m.split("\n")[0] : null);

async function getJson(deps: Deps, url: string): Promise<unknown> {
  const res = await deps.fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "iam-engine-deploy-status" },
    // Next fetch cache would mask our own TTL and the live-ness we want; always hit the network.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}${res.status === 403 ? " (rate limited?)" : ""}`);
  return res.json();
}

// A GitHubStatus instance owns one cache slot. The default export uses global fetch + Date.now;
// tests construct their own with injected fetch and clock (so TTL and error paths are deterministic).
export function createGitHubStatus(deps: Deps, repo = GITHUB_REPO, branch = GITHUB_BRANCH) {
  let cache: LatestResult | null = null;
  let cacheKey = ""; // repo+branch+runningSha — a changed running commit must re-evaluate behind_by

  async function latest(runningSha: string | null): Promise<LatestResult> {
    const key = `${repo}@${branch}:${runningSha ?? ""}`;
    const nowIso = new Date(deps.now()).toISOString();
    if (cache && cacheKey === key && deps.now() - new Date(cache.fetchedAt).getTime() < TTL_MS) return cache;

    try {
      const head = (await getJson(deps, `${API}/repos/${repo}/commits/${branch}`)) as Record<string, unknown>;
      const sha = String(head.sha ?? "");
      if (!sha) throw new Error("GitHub returned no sha");
      const commit = (head.commit ?? {}) as Record<string, unknown>;
      const committer = (commit.committer ?? {}) as Record<string, unknown>;
      const latestCommit: GhCommit = {
        sha,
        shortSha: sha.slice(0, 7),
        date: typeof committer.date === "string" ? committer.date : null,
        message: firstLine(commit.message),
      };

      let behindBy: number | null = null;
      if (runningSha && runningSha !== sha) {
        try {
          const cmp = (await getJson(deps, `${API}/repos/${repo}/compare/${runningSha}...${branch}`)) as Record<string, unknown>;
          behindBy = typeof cmp.behind_by === "number" ? cmp.behind_by : null;
        } catch {
          behindBy = null; // couldn't measure distance; we still know the SHAs differ
        }
      } else if (runningSha === sha) {
        behindBy = 0;
      }

      cache = { latest: latestCommit, behindBy, repo, branch, fetchedAt: nowIso, error: null };
      cacheKey = key;
      return cache;
    } catch (e) {
      const msg = (e as Error).message || "GitHub unreachable";
      // Serve the last good result if we still have one (staleness beats a blank), else an error result.
      if (cache && cacheKey === key) return { ...cache, error: `${msg} (showing last checked ${cache.fetchedAt})` };
      return { latest: null, behindBy: null, repo, branch, fetchedAt: nowIso, error: msg };
    }
  }

  return { latest };
}

const singleton = createGitHubStatus({ fetch: (...a) => fetch(...a), now: () => Date.now() });
export const latestFromGitHub = (runningSha: string | null) => singleton.latest(runningSha);
