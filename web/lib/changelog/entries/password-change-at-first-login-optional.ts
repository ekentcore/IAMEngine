import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "password-change-at-first-login-optional",
  date: "2026-07-16",
  time: "18:45",
  title: "Generate password: you choose whether the user must change it at first sign-in",
  items: [
    "Generated passwords always forced a change at next sign-in — which lands on the TECH when a client's equipment is set up logged in as the user before handover. (FR #0000014)",
    'The "generate random password" dialog now has a "require the user to change this password at next sign-in" checkbox (default on, AD / M365 / Google alike). Unticking it is recorded in the audit log and the run report says plainly that no change was required.',
    "Onboarding initial passwords honor the client profile's password.requireChangeAtSignIn setting — the schema always had the field; now the runner actually receives it. Default unchanged (force the change).",
    "Runner 1.69.0.",
  ],
};
