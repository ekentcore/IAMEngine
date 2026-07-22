import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-setup-wizard-and-suggestions",
  date: "2026-07-22",
  time: "09:45",
  title: "Guided setup is now a step-by-step wizard, with Delinea credential suggestions",
  items: [
    "Setting up a system's API credentials now walks you through it step by step — overview, the console prep steps, the login, a live run that advances as the automation signs in / creates the app / harvests / vaults, then a done screen with the vaulted secret",
    "A new 'Suggest from Delinea' button (anywhere you enter a credential reference) searches this client's own Delinea folders and ranks the likely secrets — showing name, note, folder path + id, template, and why it matched — so you pick instead of hunting",
    "The automatic browser run shows coarse progress by stage; the paste and existing-secret paths still work for every vendor (and are the fallback for SSO tenants)",
  ],
};
