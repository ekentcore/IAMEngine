import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-cert-exchange-options",
  date: "2026-07-20",
  time: "19:45",
  title: "M365 setup: choose whether to create the certificate + grant Exchange, and set the cert expiry",
  items: [
    "New 'Certificate & Exchange' section on the setup form. 'Create & save a certificate' (default on) controls whether a certificate is issued and vaulted — turn it off for a Graph-only client that never uses Exchange app-only auth (the credential is then client-secret-only).",
    "'Certificate expires in' picker — 1 / 2 / 3 years, defaulting to 3 years (the current maximum). The chosen validity is applied to the issued certificate.",
    "'Grant Exchange Online admin (Exchange.ManageAsApp + Exchange Administrator role)' (default on) — skip it to leave the app Graph-only. Because Exchange app-only auth needs the certificate, unchecking the certificate disables and unchecks Exchange automatically.",
    "The half-vaulted self-heal is now cert-aware: a client set up client-secret-only is no longer flagged 'stranded' for having an empty certificate slot (it was never meant to have one).",
    "All default ON, so the historical behaviour (secret + certificate + Exchange) is unchanged unless you opt out. Verified live: defaults, the 3-year default, and the cert→Exchange coupling.",
  ],
};
