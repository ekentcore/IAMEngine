import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "sharepoint-onedrive-fullaccess-grant",
  date: "2026-07-19",
  time: "08:00",
  title: "Offboard grants the delegate full OneDrive + SharePoint site access (PnP)",
  items: [
    "The m365 offboard now grants a named delegate (the intake's oneDriveGrantAccessTo) site-collection admin on the leaver's OneDrive site, plus any sites listed in the client's sharePointDelegateSites config - full access to everything on the site, not just what a folder/file share would cover",
    "Runs over PnP.PowerShell app-only auth with the SAME m365-admin certificate the Exchange Online lane already uses - Graph has no 'make this person a site collection admin' call, only per-item permissions, so this goes over SharePoint's own API instead",
    "Idempotent (checks the existing site-collection admins first) and entirely fail-soft: a missing PnP.PowerShell install, no delegate named, or any grant failure never fails the offboard - the containment steps (block sign-in, remove groups/license) already ran by the time this runs",
    "Needs PnP.PowerShell installed on the runner (self-healing install, same pattern as the Exchange Online module) and the m365-admin app registration to hold the SharePoint Sites.FullControl.All application role",
    "Built with mocked PnP cmdlets (no live tenant available in this environment) - validate the actual grant on a live tenant before relying on it in production",
  ],
};
