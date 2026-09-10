import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "self-update-keeps-browser-sidecar",
  date: "2026-09-10",
  time: "19:00",
  title: "A runner update stops deleting the browser automation it depends on",
  items: [
    "Spanning force sync sat in pending with nothing happening, and so did Entra device code — 21 browser steps queued up across the last month with no runner able to take any of them. (FR #0000121)",
    "Cause: when a runner self-updates it re-pulls its files and then deletes anything left over that the app did not send. The browser automation's dependencies — Playwright and the portable Node — are deliberately not part of what the app sends, so the cleanup deleted them. Every update destroyed the browser sidecar",
    "Once that happened the agent stopped reporting that it can run browser jobs, and the claim gate — correctly — withheld every browser job from every agent. The steps then had nobody to run them",
    "It was reinstalled by hand twice, on 24 July and 12 August, and destroyed again both times. In between, four of those steps were stopped manually with \"the step was not progressing\", which is exactly what it looked like from the outside",
    "The cleanup now leaves alone the files the update was never going to send in the first place. It still removes a genuinely stale file, which is the reason it exists — that part is unchanged and tested",
    "A browser install that does not take is no longer silent. The Agents page used to show progress for thirty minutes and then go quiet whether or not it worked; it now keeps saying so when the runner still is not reporting browser automation. An absence of something is not a thing people notice",
    "The browser sidecar still needs installing once more on the central runner — the update will stop eating it from now on",
    "Runner 1.120.0 needs deploy",
  ],
};
