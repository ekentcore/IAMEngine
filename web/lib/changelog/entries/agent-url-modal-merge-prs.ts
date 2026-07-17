import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "agent-url-modal-merge-prs",
  date: "2026-07-17",
  time: "10:30",
  title: "Change app URL from the Agents page (prove-on-one flow), honest 'moving URL' status, merge PRs + restart from Settings",
  items: [
    "New 'Change app URL' button on the Agents page: enter the new URL in a dialog and choose the blast radius - prove the move on one runner first, or migrate the whole fleet. No more hunting for the setting (it only ever rendered on the old settings page - now it's on v2 too)",
    "Prove-it-first flow: when the chosen runner lands on the new URL, a dialog offers '<runner> has successfully migrated - move all the other runners now?'. If the proof fails, the pending prompt clears itself server-side and the row shows the failure. Every step is in the audit log",
    "The migration status no longer goes silent 5 minutes after delivery: a runner that switched away shows 'moving URL - not communicating on the new URL yet (Xm)' until it reports in, and one that comes back still on the old URL says the move didn't stick",
    "Merge PRs from Settings: a dialog lists the outstanding PRs (draft/CI/conflict state) and merges one via scripts/prs.sh on the host - same battle-tested path as the terminal (branch caught up to main, squash, local sync + npm install). Hidden on hosts without a checkout, so it disappears on Azure by itself",
    "Restart server now also works on Azure App Service with no setup (the platform relaunches an exited process) - the button keeps working unchanged after the move",
    "Settings v2 drift closed: agent auto-update toggle and the agent domain migration block now render on v2 like they always did on v1",
  ],
};
