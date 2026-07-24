import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-extra-groups",
  date: "2026-07-24",
  time: "13:15",
  title: "Onboard cases: an \"Additional groups\" field under Fields to be set",
  items: [
    "The case review panel's \"Fields to be set (dry run)\" now takes a comma-separated \"Additional groups\" field. Extra group names merge into the engine's planned group adds on the same lane ticket-picked security groups use (AD when the client has one, otherwise m365/entra), pass the same protected-groups safety filter (no Domain Admins, Enterprise Admins, etc.), and the case re-plans automatically on save so they land on the planned step right away.",
  ],
};
