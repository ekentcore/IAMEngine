import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "child-modeling-inheritance",
  date: "2026-08-27",
  time: "14:00",
  title: "A child company follows its parent's roles even when it runs its own systems",
  items: [
    "Roles, personas and every-user rules now reach a child company whether or not it has systems of its own, and there is a switch on the client page to stop following them. (FR #0000041)",
    "The bug was one question doing the work of two: inheritance was decided by \"does this child have any systems of its own\", which also answered \"which roles apply to its people\". So the moment a child owned a single system it inherited no personas at all — Maywood Veterinary Clinic had none of the four its parent and its sibling clinics all run",
    "The two are now separate switches. Turning the roles link off no longer breaks the systems link, which is what made the original behaviour so confusing",
    "Nothing is ever overwritten: a child's own roles always win, and the parent only fills in what the child leaves unset. So a child that keeps its own edited copy keeps using it, and the switch is safe to toggle either way",
    "A parent that isn't modeled itself still lends nothing — it is a roster entry, not a runbook",
    "Needs a database migration: run `npx prisma migrate deploy` from web/ after this ships",
    "Web-only — no runner change",
  ],
};
