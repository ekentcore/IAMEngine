import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exo-pin-survives-selfheal",
  date: "2026-09-08",
  time: "17:00",
  title: "Exchange steps stop failing with \"does not contain a method named 'GetResponseHeader'\"",
  items: [
    "Exchange steps were failing — and Exchange Online finishes on onboards were warning — with \"[System.Net.Http.HttpResponseMessage] does not contain a method named 'GetResponseHeader'\". (FR #0000129, #0000130)",
    "Cause: one build of the Exchange Online module calls a method that PowerShell 7.6 removed. The runner already pins a known-good build for exactly this reason, and installs it at startup. But when the runner repaired a missing module mid-run it fetched the newest build instead of the pinned one — so the broken build ended up on the host permanently, and any time the pin was missing the runner fell back to it",
    "The repair now installs the pinned build, the same way it already pins Microsoft Graph sub-modules to the version already on the host",
    "The failure message no longer blames the wrong thing. It used to say \"grant the app Exchange.ManageAsApp and set its certificate\", which sent an operator to re-consent an app that was already correct. It now says plainly that this is not a permissions or certificate problem, names the module build as the cause, and gives the exact install command",
    "Runner 1.116.0 needs deploy",
  ],
};
