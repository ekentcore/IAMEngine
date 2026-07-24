import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-unified-group-removal",
  date: "2026-07-24",
  time: "17:30",
  title: "Offboards now remove Microsoft 365 (Unified) groups instead of leaving them behind",
  items: [
    "Unified groups fell between the lanes: the M365 step skipped every mail-enabled group as 'managed in Exchange', but the Exchange sweep only enumerates classic distribution groups — which never include Unified groups. Nothing removed them, silently, and the leaver stayed a member",
    "The M365 offboard now routes like the onboard mirror already did: a Unified group is mail-enabled but Graph-removable, so it goes through the same idempotent Remove-MgGroupMemberByRef path as cloud security groups",
    "Classic DLs and mail-enabled security groups still route to the Exchange step; dynamic groups (even Unified ones) stay skipped — membership is rule-managed",
    "The group evidence snapshot now records the Unified flag, so the run report shows why each group was removed or routed",
    "Runner 1.102.0 — after deploy, re-run the m365 step on an affected case to clear the leftovers (the removal is idempotent)",
  ],
};
