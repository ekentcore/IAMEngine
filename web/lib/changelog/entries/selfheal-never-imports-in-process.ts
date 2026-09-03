import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "selfheal-never-imports-in-process",
  date: "2026-09-03",
  time: "14:00",
  title: "Hotfix: the runner stops wedging itself when it repairs a missing module",
  items: [
    "The central cloud runner appeared to keep crashing, with steps stuck on \"offboard m365\". It was not crashing — one job was hanging, the stall watchdog restarted the process ten minutes later, the app handed the same job back, and it hung again. A loop",
    "Cause: when a step needs a cmdlet whose module is missing, the runner installs it and loads it on the spot. ExchangeOnlineManagement and Microsoft.Graph share the same underlying .NET libraries, so loading the second one into a process already using the first leaves two incompatible copies in memory — after which Graph calls never return at all. No error, no timeout, just a stopped step",
    "It now installs the module but does NOT load it into the running process; it restarts instead, once the current job has finished and reported. A fresh start loads everything in the right order. A missing Microsoft.Graph sub-module is unaffected and still self-heals on the spot, which is the common case",
    "The step that triggered it now fails with an explanation and a next action, rather than the bare \"the term X is not recognized\"",
    "Trigger on the day: ExchangeOnlineManagement had gone missing from the central runner, so every Exchange step on the affected client kicked off the repair",
    "Runner 1.111.0 — needs deploy",
  ],
};
