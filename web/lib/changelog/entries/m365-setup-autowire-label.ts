import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-autowire-label",
  date: "2026-07-20",
  time: "19:30",
  title: "M365 setup: the vaulted Delinea id now wires into the Secrets panel automatically, with an (auto) label",
  items: [
    "After 'Set up M365 automatically' finishes, the client's Secrets panel now reflects the wired m365-admin credential immediately — no more copying the Delinea id from the modal and pasting it into the box yourself. The setup was already saving the reference server-side; the panel just wasn't refreshing (it read its rows once on mount). It now re-syncs from the server when the wiring changes (and after the run completes the modal triggers that refresh).",
    "The wiring label is stamped with '(auto)' — e.g. 'M365 app registration (auto)' — so it's clear at a glance the credential was provisioned by the auto setup rather than hand-entered. It preserves any existing label and appends the marker once (idempotent); an already-complete client gets the label stamped on its next run too.",
    "The Delinea secret itself is also created with an '(auto)' suffix in its name.",
    "Verified live on a real client: after setup completed, the id box showed the Delinea id and the label showed 'M365 app registration (auto)' with no page reload.",
  ],
};
