import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-customer-id-validation",
  date: "2026-07-24",
  time: "17:30",
  title: "Google Workspace connection tests survive a wrong customer id in the secret",
  items: [
    "UOVO Art's google-workspace connection test failed with a bare \"400 (Bad Request)\" despite valid credentials — the token exchange succeeded, then the Directory API probe was sent a customer id read from the secret's ClientID field, which held the service account's numeric OAuth client_id instead of the Workspace customer id (C0…)",
    "The runner now validates the resolved customer value: anything that doesn't look like a Workspace customer id (all digits, an email, a domain) self-heals to my_customer with a WARN naming the fix — the real customer id lives in Admin Console → Account settings, and the numeric OAuth client ID belongs on the DWD authorization screen, not in this field (runner 1.104.0)",
    "Google API failures also stop hiding their reason: the error body PowerShell parks on ErrorDetails is appended to the thrown message, so a 400 now reads \"Invalid Input: customer …\" instead of a bare status line",
  ],
};
