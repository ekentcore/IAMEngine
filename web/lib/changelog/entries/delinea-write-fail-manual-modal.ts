import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "delinea-write-fail-manual-modal",
  date: "2026-07-20",
  time: "13:30",
  title: "When the app can't write a credential to Delinea, it now shows a how-to-do-it-by-hand modal",
  items: [
    "In guided credential setup, when the app couldn't create the secret in Delinea itself - no write account/folder/template configured, or a Delinea auth/create error - you used to get only a small red error line with nowhere to go",
    "Now that failure pops a modal that shows exactly how to create the secret by hand: which template (e.g. the M365 API key uses 'Entra Azure AD Account'), which folder, and each field with the value you already typed - copyable, with secret values masked behind a Show toggle",
    "After you create it in Delinea, paste the new Secret ID into the modal and 'Wire it' attaches the reference to the client - the same end state as the automatic path",
    "A credential the live test just proved can't authenticate still shows the inline error (not the modal) - we don't guide anyone to vault a broken credential",
  ],
};
