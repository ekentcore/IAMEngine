import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-standalone-domain-separation",
  date: "2026-08-19",
  time: "12:00",
  title: "AD-standalone clients can use a different domain on-prem from the one they use for email",
  items: [
    "New \"AD domain\" field on a client: when on-prem AD uses a different namespace from email (e.g. AD syee.local, mail olympuscosmetic.com), the on-prem account is now created with the AD domain while 365 keeps the email domain. Previously one domain was used for both and there was no way to separate them",
    "Only applies to AD-standalone clients. On an AD-synced client the two are the same by definition — the account syncs up — so nothing changes there, and nothing changes for cloud-only or Google clients",
    "Where the on-prem account is PLACED is unaffected: that has always been resolved live from the domain controller",
    "This applies to onboarding. Offboarding is unchanged and deliberately so: it finds the existing person by their sign-in name or display name against the live directory, rather than rebuilding one from a username pattern",
    "AD-standalone onboards no longer run the email write-back step, which was copying the 365 mailbox address into on-prem AD. On a standalone client the two accounts are separate on purpose, so that was wrong",
    "AD-standalone onboards no longer run the AD/Entra consistency check either. It compares the on-prem account to its synced cloud twin — on a standalone client there isn't one, so it could only ever report a mismatch",
    "Closes feature requests #0000083 and #0000107",
  ],
};
