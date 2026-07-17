import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-clears-manager-in-entra",
  date: "2026-07-16",
  time: "18:00",
  title: "Offboarding now clears the manager for cloud-only users, not just AD ones",
  items: [
    "Only the Active Directory step ever removed a leaver's manager. A cloud-mastered user (no AD lane — the JAMS case) kept the link forever, so the leaver stayed in their manager's org chart. The m365/entra step now clears it in Entra. (FR #0000012)",
    "Who the manager WAS is captured before the clear — the run report names the person, and Exchange's grant-the-manager-mailbox-access fallback can use it on a re-run even for cloud-only clients.",
    "AD-synced users are routed, not errored: their manager is on-prem-mastered, Graph refuses the write, and the AD step clears it as before. The step verification checks the link is gone for cloud users only.",
    "Opt out per client with removeManager: false on the m365 offboard config. Runner 1.69.0.",
  ],
};
