import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-proxyaddress-conflict-feedback",
  date: "2026-07-22",
  time: "15:15",
  title: "M365 onboard now names who holds a colliding email address instead of a cryptic Graph error",
  items: [
    "When adding an M365 alias fails with Microsoft Graph's \"Another object with the same value for property proxyAddresses already exists,\" the step used to surface that raw message — which never says WHICH object already uses the address. It now looks the address up and tells you exactly who holds it",
    "The lookup checks, in order: an existing live user (and whether that account is disabled), a SOFT-DELETED user (the #1 cause — a rehire or an earlier failed onboard leaves a deleted copy that reserves its addresses for ~30 days), and a mail-enabled group",
    "Example: instead of \"[Request_BadRequest] : Another object with the same value for property proxyAddresses already exists,\" you now get \"alias 'jsmith@client.com' can't be added: it's reserved by a SOFT-DELETED user (a rehire or an earlier failed run) — John Smith <jsmith@client.com>, deleted 2026-07-01. Restore & adopt that account, or permanently remove it (Remove-MgDirectoryDeletedItem) to free the address.\"",
    "The lookup is best-effort: if it can't identify the holder (permissions or a transient read failure), the error falls back to a generic \"another object in the tenant already uses it — check live users, soft-deleted users, contacts and groups\" hint rather than failing louder. Soft-deleted users are read via a raw Graph call, so no new module dependency is required",
    "Runner 1.90.0 — needs deploy. Only the M365 alias write behaves differently; all other onboard steps are unchanged",
  ],
};
