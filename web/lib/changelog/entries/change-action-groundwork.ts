import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-action-groundwork",
  date: "2026-07-18",
  time: "17:30",
  title: "Groundwork for a “change / mover” case action",
  items: [
    "Added a third case action, `change`, alongside onboard and offboard - the foundation for movers (role/location transitions) and ad-hoc access changes (add/remove an existing user to groups, DLs, shared mailboxes, licences, OU)",
    "Schema + migration only in this step: the `change` value is added to the Action enum; the planning, runner, and UI that use it land in the following changes",
    "Adjusted the handful of places that assumed a case is only ever onboard or offboard (runbook rendering, the client page's runbook preview, the planner's config lookup) so the new value type-checks cleanly with no behaviour change",
  ],
};
