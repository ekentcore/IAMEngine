import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "location-groups-lane-aware",
  date: "2026-07-22",
  time: "12:45",
  title: "Cloud-only office groups no longer get pushed to the Active Directory lane",
  items: [
    "Onboards for clients with per-office groups (e.g. Six One Commodities, cases UM0029655/57/58) showed the AD step warning \"group not found in AD: 'Houston Printix Group'\" — a Printix group that lives only in 365/Entra, not on-prem. The AD runner tried to add it, couldn't find it, and the case validation went orange",
    "Cause: a location's groups were unioned into EVERY directory lane at plan time (active-directory, entra, m365, exchange) with no way to say \"this group is cloud-only.\" A location group that only exists in the cloud was always attempted by AD",
    "Fix: the planner now checks the client's discovered group catalogs — a location group present in the Entra cloud-groups list but absent from the on-prem AD-groups list is treated as cloud-only and dropped from the AD lane, while still being added on the m365/entra lane where it actually lives",
    "Safe by default: the filter only acts on positive evidence. A client with no group discovery data keeps the old behavior (group unions into every lane), so nothing silently disappears. Groups that really are on-prem AD groups are untouched",
    "To clear an affected client, run 'Refresh AD objects' and 'Refresh cloud groups' so the catalogs are current, then re-plan the case",
  ],
};
