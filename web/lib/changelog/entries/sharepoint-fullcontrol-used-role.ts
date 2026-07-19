import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "sharepoint-fullcontrol-used-role",
  date: "2026-07-19",
  time: "08:45",
  title: "SharePoint Sites.FullControl.All stays an escalation flag - the name-only model can't clear it",
  items: [
    "A prior change reclassified a granted Sites.FullControl.All as a used, non-escalation role, on the reasoning that the offboard SharePoint / OneDrive full-access hand-off genuinely needs it (Graph can't add a site-collection administrator; that has to go over SharePoint's own API via PnP)",
    "Reverted: the over-permissioning scan matches granted roles by NAME only, with no notion of which API resource issued the grant. Microsoft Graph exposes its own app role also named Sites.FullControl.All - full control of every SharePoint site via Graph, a genuine tenant-wide escalation - and the reclassification made the scan blind to that grant wherever it is actually present, on every tenant, not just ones using the SharePoint hand-off",
    "Sites.FullControl.All is back in the escalation list in both web/lib/secrets/graph-caps.ts and runner/Start-IamRunner.ps1 (removed from the used-non-Graph-role list in both). For clients that do use the SharePoint hand-off, this means the scan will keep reporting Sites.FullControl.All as an extra-access finding - a known false positive, not a bug",
    "Documented on /help/cloud-auth: the SharePoint block still tells operators to grant Sites.FullControl.All for that hand-off, plus an explicit note that the rights scan will flag it anyway and to verify against the offboard result rather than treating the finding as real or trying to silence it again",
  ],
};
