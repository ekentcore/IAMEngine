import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-folder-tree-picker",
  date: "2026-07-15",
  time: "14:45",
  title: "Pick any AD folder for onboarding - and the pick now actually takes effect",
  items: [
    "\"Refresh AD objects from DC\" used to list only OUs, so a client whose users live in the default Users container (a CN=Users folder, not an OU) had nothing to pick. PureTech's onboard (UM0029706) failed on exactly this - 'OU=Users' does not exist. Discovery now enumerates the WHOLE tree: OUs, containers (Users, Computers, Builtin, Managed Service Accounts), and the domain root",
    "The folder tree labels containers and the domain root correctly (not just OUs), with an icon per kind so a container reads differently from an OU at a glance",
    "You can now set the onboarding OU/folder on the Active Directory system in Edit systems - type a full DN or Browse the discovered tree. This is the value the runner actually uses (config.onboard.ou)",
    "That closes a silent trap: an OU set under Roles & rules was overridden at run time by the system's own base OU, so edits there appeared to do nothing. Roles & rules now shows a warning when a base OU is set, pointing you to Edit systems - the one place the change takes effect",
    "Agents need runner 1.61.0 for the fuller folder discovery",
  ],
};
