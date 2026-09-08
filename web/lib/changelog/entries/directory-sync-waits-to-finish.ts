import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "directory-sync-waits-to-finish",
  date: "2026-09-08",
  time: "11:00",
  title: "The directory sync step waits for the sync to finish before the next step looks for the account",
  items: [
    "The step used to return the moment it TRIGGERED the Entra Connect sync, so the Microsoft 365 step ran immediately afterwards and looked up an account the sync had not written yet — the \"no synced M365 account for …\" failures. (FR #0000112)",
    "It now waits for the cycle to actually finish. A bounded poll rather than a fixed pause: it carries on as soon as the sync settles, which is usually much sooner than any delay we would have guessed",
    "If the sync is still running after two minutes it warns and moves on rather than holding the onboard, and says that a later step failing to find the account is most likely this sync still catching up",
    "Configurable per client, and setting the wait to 0 restores the old behaviour",
    "This is the other half of the AD-synced adopt fix (#0000105). That one stopped the engine misreading an account that DID exist; this one stops it looking before the account exists at all",
    "Runner 1.115.0 (directory-sync module) needs deploy",
  ],
};
