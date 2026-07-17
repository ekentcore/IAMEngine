import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-setup-test-then-write",
  date: "2026-07-17",
  time: "17:30",
  title: "Guided setup now tests a credential before it writes it to Delinea",
  items: [
    "In the guided credential setup, each step now leads with entering the credential's actual fields (with a short 'where to find this' hint per field) instead of pasting a Delinea id first - pasting an existing id is still available below",
    "M365: the entered app id + secret + tenant are run through the real Entra sign-in before anything is written - a Global Admin account or a wrong/expired secret is caught up front with a plain-language reason, and only a credential that authenticates gets created in Delinea",
    "On-prem AD (ad-dc): the app can't bind AD itself, so the pre-write check is whether the client's own runner is online and AD-capable ('test comms to the runner'); this is advisory - the secret is still created so the runner can do the real bind, and the connection test confirms it",
    "Once a credential tests ok, the app creates it in the client's Delinea folder and wires the returned id into every box that references it - no separate copy/paste step",
    "New systems are one entry away: the tester is a registry keyed by credential name (M365 and ad-dc today), and everything else falls through to the existing create-then-verify flow until a tester is added",
  ],
};
