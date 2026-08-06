import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "six-one-back-office-on-request",
  date: "2026-08-05",
  time: "12:00",
  title: "Six One: \"Back Office Users\" is added on request, not to every onboard",
  items: [
    "Every Six One onboard added the 'Back Office Users' group whether or not the ticket asked for it. It is now added only when someone picks it on the ticket — requested security groups already route to the directory that MASTERS them, which is AD for Six One, so nothing new was needed to deliver it. (FR #0000082)",
    "The request said the group was \"stuck hardcoded into the powershell\". It wasn't — no module names it. It sat in the client's AD onboard lane as an unconditional group, and the AD module simply applies the groups it is handed. That distinction is the whole reason this was a data change rather than a runner release",
    "The two CONDITIONAL Six One groups are untouched: 61C-CORE_Users (when avd is requested) and the Perimeter 81 bundle (when perimeter is requested) were already request-gated by their own conditions and still behave exactly as before",
    "profiles/six-one.json is the seed source, so the profile fix alone would not have changed the next onboard — the live config is the ClientSystem row. New scripts/backfill-six-one-back-office.ts removes it from that row, dry-run by default, idempotent, and narrow: only that group, only the AD onboard lane, only where it is actually listed",
    "The profile now carries a note saying why the group list is empty, so a future reader doesn't helpfully put it back",
  ],
};
