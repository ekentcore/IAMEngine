import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "password-reset-gui-fix",
  date: "2026-07-24",
  time: "12:45",
  title: "Password reset dialog: stable layout while typing a custom password",
  items: [
    "The \"require change at next sign-in\" checkbox row no longer stretches across the dialog and wraps its label onto a second line - it now sizes like the two radio buttons above it",
    "In manual mode, the hint/error line under the password field now reserves its space up front, so the dialog no longer jumps as you type and the requirements hint swaps in and out of a validation error",
  ],
};
