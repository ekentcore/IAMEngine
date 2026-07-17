import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "phone-requested-rule-field",
  date: "2026-07-16",
  time: "18:00",
  title: "Roles & rules can now branch on whether a phone was requested",
  items: [
    'The intake always carried the two phone flags (office line required, cell phone required) but the rules editor never offered them, so there was no way to say "phone requested → add a Teams Phone license". (FR #0000006)',
    "A new phoneRequested condition is true when EITHER flag is set — one token instead of ORing two fields. The raw officeLineRequired / cellPhoneRequired fields are also suggested for rules that target one specifically.",
    "All three are yes/no fields in the condition builder, e.g. phoneRequested is Yes.",
  ],
};
