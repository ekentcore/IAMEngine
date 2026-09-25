import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "keyboard-safe-passwords",
  date: "2026-09-23",
  time: "09:00",
  title: "Passwords only use characters every keyboard has (runner 1.135.0)",
  items: [
    "Generated passwords (new users and 🔑 resets) no longer use ^, which is a dead key on many international keyboards and can turn into a different character when typed; they're now 18 characters (16 for Google-created users) to keep the same strength",
    "Every generated password is checked before use and refused if it contains anything outside standard keyboard characters",
    "\"Enter a specific password\" now refuses characters like €, £ or accented letters, which paste fine but can't be typed back on another keyboard",
  ],
};
