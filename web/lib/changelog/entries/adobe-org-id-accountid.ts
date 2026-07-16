import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adobe-org-id-accountid",
  date: "2026-07-14",
  time: "13:15",
  title: "Adobe: the org id lives in accountid, and the runner now looks there (it never could before)",
  items: [
    "Adobe needs your organization id (…@AdobeOrg) in the URL of every call. The runner read it from a field literally named OrgId - but Delinea's 'Automation - API' template has no OrgId field, so in practice it goes in accountid. Every Adobe secret created from the stock template therefore handed the runner an empty org id and failed against a malformed URL. It now reads accountid, and about a dozen other spellings",
    "It also finds the org id by the SHAPE of the value: any field ending @AdobeOrg is recognised as the org id, whatever the field is called. A field name is a convention an operator can get wrong; the value's format is not",
    "When there genuinely isn't one, the error now names accountid, lists the fields the secret actually has, and points at /help/adobe - instead of a 403 from a URL with a hole in it",
    "Adobe was the only major system with NO app-side field check, so a misfiled org id sailed through 'wired' and only surfaced on a live run. It has one now",
    "To be clear about what you do NOT need to store: no access token (the runner mints a short-lived one on every connect), no scopes (they're fixed), and no technical account id/email - those belong to Adobe's deprecated Service Account JWT flow. If your credential came with a technical account id and a private key, it's the wrong integration type",
    "Separately, fixed 3 logging calls that would THROW instead of logging - Write-CtgLog took the level before the message, so passing the message first died on the level's validation. All 3 were inside catch blocks, so the only thing they could break was the code trying to report a problem",
  ],
};
