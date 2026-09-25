import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adopt-uses-the-confirmed-account",
  date: "2026-09-24",
  time: "13:00",
  title: "Adopt actually adopts the existing account instead of asking again (runner 1.141.0, FR #175)",
  items: [
    "Onboarding someone who already had a Microsoft 365 account could loop: the step asked to Adopt or use a different username, Adopt re-ran it, and it asked again. It happened when the existing account's name didn't match the ticket exactly - \"Doe, Jane\", a maiden name, a middle initial",
    "Adopt now records the exact account you were shown, and the Microsoft 365 step adopts that account whatever its display name, marks it as the engine's, and carries on with licences and groups",
    "The answer is also saved on the step that asked, so an Active Directory or Google step asking the same question no longer re-runs without it",
    "Automatic adoption for a rehire is unchanged: without your confirmation, only an account with the same name is adopted, never whoever happens to hold the username",
  ],
};
