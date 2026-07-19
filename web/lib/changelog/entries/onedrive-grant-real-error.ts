import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "onedrive-grant-real-error",
  date: "2026-07-19",
  time: "07:30",
  title: "Offboard OneDrive grant now reports Graph's real error",
  items: [
    "A failed OneDrive read or delegate-access grant during offboard used to log a bare 'BadRequest' with no way to diagnose it - the WARN now carries Graph's actual error code and message",
    "The 'needs the Files.ReadWrite.All app role?' hint only appears when Graph actually returned a 403/Authorization_RequestDenied, instead of on every failure regardless of cause - runner needs deploy",
  ],
};
