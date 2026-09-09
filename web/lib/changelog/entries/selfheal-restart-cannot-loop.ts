import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "selfheal-restart-cannot-loop",
  date: "2026-09-09",
  time: "10:00",
  title: "Hotfix: the runner stops taking itself offline when a module repair does not stick",
  items: [
    "The central runner kept needing a manual restart. This was a regression in last week's wedge fix, and the apology is owed: that change made the runner restart itself after installing a module it could not safely load in a running process",
    "On a supervised host, restarting means exiting and trusting the service manager to bring it back. When that relaunch does not happen, the runner does not crash noisily — it stops cleanly and stays stopped, which is why it looked like a crash and needed starting by hand",
    "If the same repair kept being needed every poll cycle, that exit happened every cycle",
    "It now restarts at most once per repair per hour. If a restart has already been tried and the module is still missing, it says so loudly and keeps running instead — the step needing that module fails with a clear message, and every other system carries on",
    "Runner 1.117.0 needs deploy",
  ],
};
