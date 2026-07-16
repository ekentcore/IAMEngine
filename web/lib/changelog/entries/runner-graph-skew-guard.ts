import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runner-graph-skew-guard",
  date: "2026-07-13",
  time: "13:00",
  title: "Runner: Microsoft.Graph version-skew self-repair (PR #30, runner 1.44.0)",
  items: [
    "Runners that died at startup with 'Assembly with same name is already loaded' (mixed Microsoft.Graph module versions) now realign themselves automatically before loading",
    "Self-healed Graph module installs are pinned to the host's existing version instead of grabbing the newest - the drift source",
    "The troubleshoot script flags a mixed Graph set with the exact fix",
  ],
};
