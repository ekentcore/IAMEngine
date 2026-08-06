import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "prs-announces-to-chat",
  date: "2026-08-06",
  time: "15:00",
  title: "prs.sh tells the chat rooms what shipped, straight after the merge",
  items: [
    "Merging a PR now offers to post what it shipped to the configured chat rooms, so an update reaches the room without anyone remembering to open /changelog and click Send to chat",
    "Nothing is configured twice. The Postgres credentials come from the repo-root env file (POSTGRES_*), assembled into a DATABASE_URL by the same helper that writes web/.env — no connection string is ever passed as an argument, because argv carries the password into `ps`. The chat destinations come from that database: the same Settings > Notifications row every other alert reads, so switching a room off in the UI switches it off here too, with no redeploy",
    "It announces the CHANGE-LOG ENTRIES the PR added — the human description of what shipped, already written and reviewed as part of the PR. A PR with no entry announces nothing rather than inventing a summary out of commit messages",
    "It asks first. These are real customer rooms and a message can't be recalled, so with a terminal it shows a dry run — the resolved destinations and the exact text — and then asks; PRS_ANNOUNCE=1 sends without asking, PRS_NO_ANNOUNCE=1 never sends, and with no terminal it prints the command and stays quiet. Same treatment a database write already gets",
    "The announcement runs LAST and can never fail a merge: in a --all batch it goes after the local sync and the migration deploy, so what reaches the room is what is actually deployed — not what merged a minute before the database caught up",
    "The message is composed and sent by the app's own modules, so a send from the terminal is byte-identical to one from the button. The composition used to live inline in the send route; it is now a shared, unit-tested helper, because the same message going out two ways is exactly how two messages start to differ",
    "New scripts/announce-merged.ts can also be run on its own: --pr <n> to resolve a merged PR's entries, --entry <id> for one by name, --dry-run to see it without sending, --audience to pick the rooms. An unknown entry id is a hard error, never a silent no-op",
  ],
};
