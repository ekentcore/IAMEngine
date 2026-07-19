import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mailbox-mirror-names-source",
  date: "2026-07-19",
  time: "08:15",
  title: "Shared-mailbox mirror names each mailbox + who it was mirrored from",
  items: [
    "Each shared-mailbox grant line now reads \"granted FullAccess on shared mailbox finance@x.com (Finance) — mirrored from John Smith\" instead of just \"shared mailbox FullAccess: Finance\" - an auditor reading a single line can now tell which mailbox and whose access was copied, for FullAccess, SendAs, and SendOnBehalf alike",
    "SMTP resolution falls back to the mailbox's already-resolved unique identifier when PrimarySmtpAddress isn't available, so the line stays readable even off an incomplete mailbox record",
  ],
};
