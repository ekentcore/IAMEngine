import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "model-files-readwrite-perm",
  date: "2026-07-19",
  time: "07:45",
  title: "Files.ReadWrite.All is now in the rights test + setup guide",
  items: [
    "The offboard OneDrive delegate hand-off (runner 1.69.0) has needed Files.ReadWrite.All since it shipped, but nothing checked for it - the connection test, the fleet permission audit, and the setup page at /help/cloud-auth all stayed silent about it, so a tenant missing the permission only found out when the grant itself failed mid-offboard",
    "The connection test, fleet audit, and /help/cloud-auth now all ask for it, alongside its higher-privileged alternative Sites.ReadWrite.All",
    "Optional, same as the other capabilities that degrade gracefully: a miss shows as a warning, never a red failure, and the offboard step still fails on its own with a clear error if the permission truly is missing - this just makes the gap visible ahead of time instead of only at run time",
    "Grant it in Entra -> App registrations -> API permissions -> Microsoft Graph -> Application permissions -> Files.ReadWrite.All, then Grant admin consent. Verified against Microsoft's own Graph service principal with npx tsx scripts/verify-graph-role-ids.ts",
  ],
};
