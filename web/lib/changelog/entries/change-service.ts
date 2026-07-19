import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-service",
  date: "2026-07-18",
  time: "18:00",
  title: "Change/mover: case create + confirm service",
  items: [
    "Creates a change case held for review, then applies the operator's scoped/full/add-only removal-mode choice by replanning the case's jobs",
    "Internal groundwork on the change planning path — mover excludes Exchange in v1 (its Change lane leg only understands DLs/365-groups/shared mailboxes, not security groups)",
  ],
};
