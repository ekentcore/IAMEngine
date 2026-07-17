import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "manual-set-password-option",
  date: "2026-07-17",
  time: "18:15",
  title: "Passwords: set a specific one, or generate — your choice",
  items: [
    "The reveal/generate flow was great, but some users need a SPECIFIC password — e.g. BayPine wants a correcthorsebatterystaple-style passphrase — and there was no way to set one. (FR #0000017)",
    'The password dialog on a case\'s AD / M365 / Google line now offers two choices: "Generate a random password" (unchanged — shown once, then wiped) or "Enter a specific password".',
    "A specific password is validated against the account's complexity policy (8–256 chars, 3 of upper/lower/number/symbol) before it's set, so a doomed value is caught up front instead of failing on the runner. It's set as-is — no one-time reveal, because you already have it.",
  ],
};
