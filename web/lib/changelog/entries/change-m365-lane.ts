import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-m365-lane",
  date: "2026-07-18",
  time: "18:30",
  title: "Change/mover: M365/Entra change executor",
  items: [
    "New M365/Entra change executor: add/remove cloud Entra groups by name (resolved live) and add/remove licenses by name/skuId — the entra lane shares it via the existing m365 dispatch alias",
    "Group/license removal follows the AD lane's audit-integrity pattern: a real Graph failure logs a WARN, an idempotent not-found (already not a member) is a benign skip, never a false 'removed' line",
  ],
};
