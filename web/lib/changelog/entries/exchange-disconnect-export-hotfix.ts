import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exchange-disconnect-export-hotfix",
  date: "2026-07-16",
  time: "12:30",
  title: "Hotfix — this morning's Exchange fix broke every Exchange step: \"The term 'Disconnect-CtgExchange' is not recognized\"",
  items: [
    "The tenant-isolation fix (11:45) added a function to close the Exchange session, and registered it in one of the two places a runner module has to list a function. PowerShell requires both and quietly intersects them, so the function was never published — and the step that called it failed before it could connect. That turned a bug affecting one client into one affecting every Exchange step on the fleet. It was live for roughly 40 minutes",
    "Fixed by publishing the function properly. The session teardown also moved inside the Exchange module, so the step no longer depends on a name resolving across files — the failure mode that caused this can't recur there",
    "There was already a guard for exactly this, and it had a blind spot: it checked that everything the module publishes is in the manifest, and that the manifest doesn't name deleted functions — but not that everything the manifest names is actually published. This landed precisely in that gap, so it passed. The missing check is now in place for every module. Both files look correct on their own; the mistake only exists between them, which is why review can't see it",
    "No effect on data or cases: the step failed cleanly before connecting, so nothing partially ran. Cases that failed on it can simply be re-run once this deploys",
  ],
};
