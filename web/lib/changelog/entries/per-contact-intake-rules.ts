import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "per-contact-intake-rules",
  date: "2026-07-21",
  time: "14:30",
  title: "Per-contact intake rules — one requester's onboardings can now follow a different plan",
  items: [
    "A client can now be configured so that when a specific ServiceNow requester submits an onboarding, the plan skips chosen systems and forces a different email domain for the new account — everyone else still gets the client's normal plan.",
    "Built for Shawmut's split workflow: onboardings opened by their outside recruiting contact skip Active Directory and directory sync entirely and get an @shawmutinfinite.com address instead of the usual domain.",
    "The rule is matched by the requester's ServiceNow contact record, not by name text, so it keeps working even if the requester's display name changes. A picker on the client's Roles & rules page looks up the contact directly from ServiceNow instead of requiring the sys_id to be typed in by hand.",
    "The case screen shows a badge whenever a plan was adjusted by one of these per-contact rules, so it's visible at a glance that the case isn't following the client's default plan.",
  ],
};
