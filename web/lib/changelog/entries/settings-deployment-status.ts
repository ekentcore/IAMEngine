import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "settings-deployment-status",
  date: "2026-07-24",
  time: "10:30",
  title: "Settings now shows a 'Deployment status' note — is the site running the latest push?",
  items: [
    "At the bottom of Settings: the commit THIS server was built from vs the latest commit on GitHub main, with a verdict — 'Running the latest push', 'N commits behind — redeploy to update', or 'couldn't determine'",
    "The running commit is baked into the image by CI (a build-info.json written into the build context — the container has no .git); running from a local checkout, it falls back to reading .git, so localhost shows its real commit too",
    "The latest commit comes from the public GitHub API (no token). Results are cached ~5 min to stay under the unauthenticated rate limit, and any GitHub error degrades gracefully (shows the running commit + 'couldn't reach GitHub') instead of breaking the page",
    "Exact 'N commits behind' comes from the GitHub compare API, called only when the running build differs from the tip; SHAs and dates link to the commits on GitHub and render in the viewer's timezone",
    "Repo/branch default to ekentcore/IAMEngine@main, overridable via GITHUB_REPO / GITHUB_BRANCH env",
  ],
};
