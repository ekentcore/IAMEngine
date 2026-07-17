import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "unlicensed-user-holds-mimecast-spanning",
  date: "2026-07-16",
  time: "19:00",
  title: "No M365 license? Mimecast and Spanning now wait instead of failing for four hours",
  items: [
    "When no license seat was free, the m365 step succeeded with a warning (user created unlicensed) and Mimecast/Spanning dispatched anyway — an unlicensed user has no mailbox, so they can never be discovered, and both steps burned their entire ~4-hour retry budget on a guaranteed failure. (FR #0000005)",
    'Those steps are now HELD the moment the m365/entra step reports a seat shortage. The step line says why: "waiting for an M365 license — pick a license on the m365 step and re-run it".',
    "The hold releases itself: once a licensed m365 re-run lands (the existing license picker → re-run path), the held steps dispatch on their own. \"Run this step only\" still works as an explicit override.",
    "Runner 1.69.0 reports the shortage explicitly; older runners are inferred from the license inventory they already return.",
  ],
};
