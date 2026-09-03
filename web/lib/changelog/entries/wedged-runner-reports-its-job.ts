import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "wedged-runner-reports-its-job",
  date: "2026-09-03",
  time: "16:00",
  title: "A step no longer sits at \"running\" for half an hour after the runner restarts",
  items: [
    "When the runner is killed mid-step — the stall watchdog catching a wedged process, a reboot, or an operator restart — the step it was running now fails with an explanation as soon as the runner is back, instead of sitting at \"running\" until its claim expires",
    "Before, nothing said anything for ten minutes while the claim aged out; the step was then quietly re-queued and only failed some time after that. Half an hour of a case looking busy while nothing was happening",
    "The message says what actually happened — how long the step had been running, that the runner stopped underneath it, and that nothing is known to have completed, so re-run it",
    "This is the safety net for the wedge fixed earlier today, not a replacement: it does not stop a step hanging, it stops a hang from being invisible",
    "Runner 1.112.0 — needs deploy",
  ],
};
