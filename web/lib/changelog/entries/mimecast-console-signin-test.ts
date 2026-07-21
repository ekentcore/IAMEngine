import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mimecast-console-signin-test",
  date: "2026-07-21",
  time: "10:45",
  title: "Mimecast setup: Automatic (browser) tab with a console sign-in test",
  items: [
    "The Setup Mimecast API dialog has a new Automatic (browser) tab: the goal is for the runner to drive the Mimecast console and create the API application for you, rather than doing it by hand. This is Phase 1 - a Test sign-in button that proves the runner can sign into the Administration Console (the automated app-creation follows once sign-in is proven)",
    "Sign-in uses a new, separate mimecast-console Delinea secret (a Mimecast admin email + password, with One-Time Password enabled for MFA) - distinct from the mimecast API 2.0 credential. The runner mints the TOTP at the prompt via the OTP broker; push/SMS MFA is a hard-stop",
    "Runs on the central runner, gated on the browser capability, and never fails a real case (it's an ad-hoc browser action). The Mimecast console DOM is unverified until validated against a live tenant via the Test sign-in button; the manual Paste fields path remains the alternative and the fallback",
  ],
};
