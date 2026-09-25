import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "default-password-on-case",
  date: "2026-09-22",
  time: "18:30",
  title: "Onboarding cases show the client's default password",
  items: [
    "For a client whose new users get a fixed default password, an onboarding case's Actions menu now has \"Show default password\" with a Copy button, so it can be sent to the client without digging through the client's settings",
    "It's the client's standing default, so it isn't one-time like a generated password, but every view is recorded in the audit log, and only roles that can run cases see it",
    "For a client whose default password is kept in Delinea, it shows the Delinea secret number instead - the app never holds that value",
  ],
};
