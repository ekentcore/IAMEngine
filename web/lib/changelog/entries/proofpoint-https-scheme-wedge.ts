import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "proofpoint-https-scheme-wedge",
  date: "2026-07-20",
  time: "12:00",
  title: "Fixed: a Proofpoint step could freeze the central runner",
  items: [
    "The central runner appeared to stop working: it went quiet for ~75 seconds at a time and stopped picking up other jobs. The cause was a Proofpoint onboarding step whose stored web address had no 'https://' in front of it, so the runner tried plain http (port 80) — which Proofpoint no longer answers — and every request hung until the network gave up",
    "The runner now forces https for Proofpoint no matter how the address is stored (a bare host or an old http:// address is upgraded automatically), so these calls connect instantly again",
    "Added a 30-second cap on each Proofpoint request as a backstop, so a black-holed address can never wedge the runner for the full ~75-second system timeout again",
    "Audited every other system that reads a web address from a stored secret: Spanning had the same gap and now auto-forces https too; SentinelOne, XMatters and LogicMonitor already did the right thing",
    "All fixes are covered by tests; ships in runner 1.77.0",
  ],
};
