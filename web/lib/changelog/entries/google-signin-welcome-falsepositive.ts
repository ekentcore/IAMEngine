import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-signin-welcome-falsepositive",
  date: "2026-07-21",
  time: "09:00",
  title: "Google sign-in: stop reading the 'Welcome' heading as a rejected sign-in",
  items: [
    "THE SYMPTOM: after the de-headless-UA fix, the Google Workspace sign-in started failing at the password step with 'Google rejected the sign-in: Welcome'.",
    "THE CAUSE: the flow's error detector matched Google's obfuscated heading class as well as real error markers. With a normal (non-headless) User-Agent, Google serves the newer sign-in layout whose password page carries a 'Welcome' <h1> in that class — so the detector read 'Welcome' and aborted a perfectly good sign-in. Old headless got a legacy layout without that heading, which is why it only surfaced now.",
    "THE FIX: error detection is narrowed to genuine ARIA error semantics (role=alert / aria-live=assertive), which a heading is not, plus a defensive text guard that ignores known benign labels ('Welcome', 'Sign in', 'Choose an account'). Real errors ('Wrong password', 'Couldn't sign you in') are still caught. Unit-tested with isBenignSigninText().",
    "Ships in runner 1.79.3.",
  ],
};
