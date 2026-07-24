import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "conn-test-optional-flag-survives-wire",
  date: "2026-07-24",
  time: "15:15",
  title: "Missing OPTIONAL Graph permissions no longer show as a red \"missing N\"",
  items: [
    "A healthy M365 credential that lacked only optional Graph capabilities (MFA cleanup, Mail.Send, device disable, password reset, OneDrive delegate, mailbox-conversion read) showed a red \"✗ missing 6\" on its entra/m365 connection tests instead of \"✓ ops +6 optional\" (seen on core1747)",
    "Root cause: the runner's secret-scrub rebuilt each rights row as bare op/ok/detail before posting, silently dropping the `optional` flag the probe had set — the app then counted every optional miss as a required one (runner 1.99.1)",
    "The app also derives the flag itself now (a rights row's op is the capability's need string), so rows already stored and agents not yet on 1.99.1 render correctly immediately",
  ],
};
