import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adobe-onboard-empty-profiles",
  date: "2026-07-22",
  time: "16:30",
  title: "Adobe onboard no longer crashes when a client has no product profiles configured",
  items: [
    "An Adobe onboard for a client with no productProfiles configured (Adobe onboard is often just \"ensure the user is in the org\") failed with \"The property 'Count' cannot be found on this object\" instead of cleanly doing nothing — seen on DHM Partners cases UM0029790 and UM0029791",
    "Cause: the product-profile list was built with `@(...) | Where-Object`, whose result is null (not an empty array) when nothing matches, and reading `.Count` on null throws under PowerShell StrictMode — so the step crashed before it could report \"no product profiles configured — nothing to grant\"",
    "The list is now always an array, so an empty/absent productProfiles config is a clean no-op success, and a configured one still grants each profile as before",
    "Runner 1.92.0 — NEEDS DEPLOY",
  ],
};
