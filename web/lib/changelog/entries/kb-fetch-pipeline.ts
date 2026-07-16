import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "kb-fetch-pipeline",
  date: "2026-07-13",
  time: "13:00",
  title: "KB fetch: faithful steps + systems wired on save (PR #29)",
  items: [
    "Group and DL addresses in a KB now survive the AI parse (no more [user]@domain placeholders in runbook steps)",
    "Saving a runbook creates any modeled systems the client is missing - a KB-sourced client is no longer left with steps but zero systems",
    "New 'Sync systems from runbook' button on the client page to re-wire after a KB edit",
    "Table-of-contents style KBs parse correctly without AI, and the AI extract retries when it drops sections",
  ],
};
