// Pure comparison between the commit THIS build was made from and the latest commit on the tracked
// GitHub branch. Kept dependency-free so the verdict is trivially unit-testable; the data-fetching
// (build-info from disk, latest from the GitHub API) lives in sibling modules and is injected here.

export type Verdict = "up-to-date" | "behind" | "unknown";

// runningSha  — the commit the running server was built from (null if this build didn't record it)
// latestSha   — HEAD of the tracked branch on GitHub (null if we couldn't reach GitHub)
// behindBy    — commits the running commit is behind the branch (from the compare API); null = unknown
//
// Rules: no running or no latest → unknown (can't compare). Same SHA, or the compare says 0 behind
// (running commit is at/ahead of the branch tip — e.g. a local dev checkout) → up-to-date. Anything
// else (a different SHA that is genuinely behind, or a difference we couldn't measure) → behind.
export function computeVerdict(runningSha: string | null, latestSha: string | null, behindBy: number | null): Verdict {
  if (!runningSha || !latestSha) return "unknown";
  if (runningSha === latestSha) return "up-to-date";
  if (behindBy === 0) return "up-to-date";
  return "behind";
}

// Human label for the verdict. behindBy pluralizes the count when we have it; a "behind" verdict with
// an unknown distance still says the truth ("not the latest push") without inventing a number.
export function verdictLabel(verdict: Verdict, behindBy: number | null): string {
  switch (verdict) {
    case "up-to-date":
      return "Running the latest push";
    case "behind":
      if (behindBy && behindBy > 0) return `${behindBy} commit${behindBy === 1 ? "" : "s"} behind — redeploy to update`;
      return "Not the latest push — redeploy to update";
    case "unknown":
      return "Couldn't determine — see details below";
  }
}
