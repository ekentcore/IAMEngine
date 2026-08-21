import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "multiple-mailbox-delegates",
  date: "2026-08-07",
  time: "13:00",
  title: "An offboard can grant mailbox and OneDrive access to more than one person",
  items: [
    "FR #7 built the case-requested delegate for exactly ONE person — a single name on the intake, a single string on the job config — so a ticket naming two people silently delivered access to one. All of it now takes a list. (FR #0000084)",
    "The intake reads the delegate field as a LIST, the way ServiceNow returns a multi-value reference (\", \"-joined) — the same treatment the direct-reports field already gets. A single-valued field still yields one name",
    "Every named delegate gets Full Access to the mailbox (AutoMapping on) and access to the OneDrive, each name resolved to a real mailbox or user at run time",
    "Each delegate is INDEPENDENT: a name that can't be resolved, or a grant Exchange refuses, warns about THAT name and the rest still get their access. One typo in one row must never cost the other people theirs — that would turn a typo into silent data-access loss",
    "Blank rows and repeated names are dropped before anything is planned. A duplicate would be granted twice and logged twice, which reads on the case like two different people got access",
    "Deliberate wire compatibility: ONE delegate still travels as a plain string, byte-identical to what shipped before, so a runner that hasn't picked up the new module behaves exactly as it does today. The list shape appears only when there is genuinely more than one name — the new behaviour engages only when the new feature is used",
    "Runner 1.108.0 (Exchange + M365 modules) needs deploy",
  ],
};
