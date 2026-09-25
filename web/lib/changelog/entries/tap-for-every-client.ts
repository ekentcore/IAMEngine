import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "tap-for-every-client",
  date: "2026-09-22",
  time: "18:15",
  title: "Temporary Access Pass can be added to any client",
  items: [
    "Temporary Access Pass (tap) is now in every client's Edit systems \"add system…\" list - before, it existed only on Coretelligent, because it had been set up by hand there and was missing from the list other clients choose from",
    "Adding it sets it up like Coretelligent's: onboarding only, after Microsoft 365, using the client's m365-admin credential",
    "Each tenant still needs the app permission UserAuthenticationMethod.ReadWrite.All and Temporary Access Pass enabled in Entra's Authentication methods policy; the step says which is missing if either is",
  ],
};
