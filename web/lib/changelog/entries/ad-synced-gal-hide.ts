import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-synced-gal-hide",
  date: "2026-07-24",
  time: "18:00",
  title: "AD-synced offboards now hide the leaver from the address book via AD instead of warning",
  items: [
    "Offboarding a user at an AD-synced client used to end with a WARN — 'could not hide from GAL — the mailbox is directory-synced' — because Exchange Online refuses to modify a synced mailbox and nothing told the AD step to do it instead (FR #0000036)",
    "The planner now stamps the on-prem hide (msExchHideFromAddressLists=TRUE) onto the active-directory step for ad_synced clients, and the Exchange step stands down automatically — the hide happens in AD and Entra Connect syncs it up",
    "A client's own hide attribute (e.g. a custom attribute + sync rule) is kept exactly as configured, an opt-out (hideFromGal: false) on either lane still wins, and the per-case 'Keep in global address list' checkbox still skips everything",
    "The AD write is idempotent (an already-hidden user is left alone) and an AD without the on-prem Exchange schema WARNs with what to do instead of failing — the disable, manager clear and OU move always still run",
    "Existing planned offboards pick up the AD hide on their next re-plan; the runner side lands with the next runner deploy (1.101.0)",
  ],
};
