import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "coretelligent-post-reset-restore",
  date: "2026-07-13",
  time: "16:30",
  title: "Coretelligent: post-reset restore (TAP, offboard wiring, Delinea creds)",
  items: [
    "The TAP (Temporary Access Pass) onboarding step and the full 12-system offboard wiring lost in the July 13 database reset are restored, now carried by the profile so a reseed keeps them",
    "Delinea credentials rewired from the \\Coretelligent\\IT Support folder: exchange-onprem back to the IAM API AD account, plus Zoom, xMatters and SentinelOne ids recovered",
    "Cloud steps pinned to Coretelligent's own agent again (the Exchange Online cert lives in that box's Windows cert store)",
    "Profiles can now declare runLast (planner runs that system after everything else - used by the offboard notification)",
  ],
};
