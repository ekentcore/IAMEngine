import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-customer-id-validation",
  date: "2026-07-24",
  time: "17:30",
  title: "Google Workspace connection tests stop failing with a bare \"400 (Bad Request)\"",
  items: [
    "UOVO Art's google-workspace connection test failed with a bare \"400 (Bad Request)\" despite valid credentials — the token exchange succeeded, then the Directory API probe sent an EMPTY customer= param: the customer id the session was connected with lived in the module's private scope, and the probe read a same-named variable in the runner's scope that was never assigned, so the configured value never crossed the module boundary (runner 1.104.0)",
    "The probe now reads the connected customer through a new exported seam (Get-CtgGoogleCustomer), so the configured value actually reaches the wire",
    "That value is also validated on connect: a secret whose ClientID/CustomerId field doesn't look like a Workspace customer id (all digits — usually the service account's OAuth client ID — an email, a domain) self-heals to my_customer, with a WARN in the runner log AND an advisory row on the connection test naming the fix: the real customer id lives in Admin Console → Account settings, and the numeric OAuth client ID belongs on the DWD authorization screen, not in this field",
    "Google API failures also stop hiding their reason: the error body PowerShell parks on ErrorDetails is appended to the thrown message, so a 400 now reads \"Invalid Input: …\" instead of a bare status line",
  ],
};
