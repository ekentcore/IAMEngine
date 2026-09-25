import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "sharepoint-grants-out-of-process",
  date: "2026-09-25",
  time: "17:00",
  title: "Fix: the central runner stopped mid-job after 1.127.0 — the SharePoint hand-off now runs in a separate process",
  items: [
    "Since runner 1.127.0 the central runner would stop part-way through a Microsoft 365 job and be restarted, which showed up on cases as \"the runner stopped while this step was running\". Jobs had to be re-run, sometimes more than once",
    "Cause: granting a leaver's manager access to their OneDrive loads the SharePoint toolkit, which carries its own copies of the same Microsoft sign-in components Microsoft 365 uses. Loaded together in one process, the Microsoft 365 calls stop responding — so the next job hangs until the watchdog restarts the runner. Nothing was wrong with the job itself",
    "The 1.127.0 fix that repaired the SharePoint toolkit's installation is what first made this reachable: before it, the toolkit was never actually installed on that runner, so the two never met",
    "The hand-off now runs in its own short-lived process. The Microsoft 365 work stays where it was, so nothing else changes — and the runner can no longer be affected by it",
    "A grant that fails now says which delegate and which site, and a helper that reports nothing is recorded as such rather than passing as success",
    "Deploy runner 1.131.0. Until it is deployed, removing PnP.PowerShell from the runner host also stops it, at the cost of the site-access grant not running",
    "Not yet proven: a SUCCESSFUL grant against a live tenant. The new process was exercised end to end and correctly reported a rejected certificate, but no real site access has been granted through it yet",
  ],
};
