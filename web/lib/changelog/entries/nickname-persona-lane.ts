import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "nickname-persona-lane",
  date: "2026-07-12",
  title: "Nickname-aware onboarding + persona-gated systems (PR #20)",
  items: [
    "Nickname from the intake form now drives the AD first name when filled (Bill, not William)",
    "SamAccountName / UPN / email derive from the nickname: William Smith with nickname Bill = BSmith, not WSmith",
    "New 'by persona' lane: systems like xMatters are set up only for hires whose persona lists them, and cleaned up at offboard",
    "Runner 1.40.0: rehires still match their existing legal-name accounts (no duplicates or collisions)",
  ],
};
