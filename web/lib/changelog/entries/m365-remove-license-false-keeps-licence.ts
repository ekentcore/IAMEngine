import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-remove-license-false-keeps-licence",
  date: "2026-09-23",
  time: "16:15",
  title: "Offboards: removeLicense: false now keeps the Microsoft 365 licence (runner 1.139.0)",
  items: [
    "A client profile that set removeLicense to false still had the licence taken off the leaver by the Microsoft 365 step - the setting was read as 'configured', not as 'no'",
    "It now keeps the licence and says so on the run report ('license kept: this client's profile sets removeLicense to false'); the string \"false\" in a hand-edited profile is read the same way",
  ],
};
