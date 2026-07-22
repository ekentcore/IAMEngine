import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "conntest-not-needed-rows",
  date: "2026-07-22",
  time: "13:45",
  title: "Connection tests now show \"not needed\" credentials as read-only N/A rows",
  items: [
    "A system whose credential is marked \"not needed\" (a manual step — every required secret set to NOT_NEEDED) now appears in the Connection tests table as its own row: the system name, N/A under every stage column (Where, Fields, Can access, API works, Rights), and \"Cred Has Been Marked as Not Needed\" in Detail. There's no Retest button on it",
    "Before this, such a system was still dispatched when you pressed \"Test connections\" — the runner claimed it, tried to broker the credential, and hit \"secret is marked not needed — nothing to test,\" leaving a confusing failed/error row (or nothing at all). Now it's never dispatched",
    "Optional secrets are ignored when deciding this: an AD / directory-sync system that authenticates as ambient SYSTEM on a domain controller (whose only secret is the optional ad-dc) is still tested normally — it's never mistaken for a manual step",
    "A system that used to have a real credential and was marked not-needed afterwards no longer lingers as a stale failed row — the read-only N/A row supersedes it",
    "The panel also loads current results on open, so prior test outcomes and these not-needed rows are visible without first pressing \"Test connections.\" Web-only — no runner change",
  ],
};
