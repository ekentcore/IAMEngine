import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-progress-modal",
  date: "2026-07-20",
  time: "16:00",
  title: "M365 auto-setup: a centered progress modal with a live step tracker, an optional-permission picker, and the vaulted Delinea id",
  items: [
    "Setup progress was a line of text next to the button that ran off the screen. It's now a centered modal with a live step tracker — Connect → Sign in as Global Admin → Configure the app registration → Save the credential to Delinea — that lights each step as the run reaches it (the device sign-in code shows on the active step for a manual MFA hand).",
    "The run now reports each stage as it enters it (setupM365ForClient gained an onStage callback the run recorder persists onto the client row), so the tracker advances live instead of only jumping at the end.",
    "New optional-permission picker on the start form: required Graph permissions are always granted; the optional ones are a checklist you tick per client (each is requested and admin-consented during setup). Provisioning grants exactly the chosen set — graph-caps.roleNamesForOptionalSelection + provision's new optionalRoles input.",
    "On success the modal shows the Delinea secret id the credential was vaulted as (read back from the client's m365-admin Secret) with a copy button — so an operator finally knows WHICH vault entry to wire/test, instead of a dead-end 'done'.",
    "Fixed a stray full-width checkbox in the picker (the global input rule was stretching it).",
  ],
};
