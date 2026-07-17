import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "default-shared-mailbox-access",
  date: "2026-07-17",
  time: "18:15",
  title: "Clients: add every new user to shared mailboxes by default",
  items: [
    "Some clients need every new hire granted access to specific shared mailboxes — e.g. 61C's \"Global Vacation Calendar\" — but there was no way to set that as a default. (FR #0000015)",
    'A client\'s M365 section now has a "Default shared mailbox access" editor: pick the mailboxes and the permission level (Full access / Send as / Send on behalf) every onboard should grant.',
    '"Refresh mailbox list" asks the central runner to read the tenant\'s shared mailboxes over Exchange Online, so you can pick from the real list instead of typing addresses (needs the m365-admin EXO cert; you can still type an address).',
    "The m365 onboard lane applies the grants over the same Exchange Online connection it already uses, idempotently — a re-run only fills gaps. Re-plan a client's open cases to apply new defaults.",
    "Runner 1.73.0.",
  ],
};
