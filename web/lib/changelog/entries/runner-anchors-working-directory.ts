import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runner-anchors-working-directory",
  date: "2026-09-18",
  time: "11:00",
  title: "The runner starts from its own folder, so a Store-installed PowerShell can't send writes into a read-only directory",
  items: [
    "Starting the runner under a PowerShell installed from the Microsoft Store could fail with \"Access to the path 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_…\\Scripts' is denied\". That folder is read-only even for an administrator, and a Store PowerShell starts sitting in it (FR #0000171)",
    "The runner now moves to its own install folder before it does anything else, which is the same fix the reporter found by hand — made permanent, so nobody has to edit the script",
    "Both kinds of location are set. PowerShell commands and .NET file calls track separate current directories, and setting only the one people usually think of leaves half the writes still pointing at the read-only folder",
    "The path being written is not one of ours — every path this runner writes is already anchored to its own folder. It comes from inside a Microsoft module used while installing the cloud modules at startup, which on some hosts works out a per-user path relative to wherever the process happens to be. That cannot be fixed from here; where the process starts can",
    "Best-effort: a host where the move is refused still starts, with a warning naming what could go wrong",
    "Deploy runner 1.129.0",
    "Honest caveat: the original failure could not be reproduced here, on the same Store PowerShell 7.6.6 build, so this is a fix for the condition that produces it rather than a confirmed repair. If it recurs after this deploy, the next step is capturing which command fails on that host",
  ],
};
