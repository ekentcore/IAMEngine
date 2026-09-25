import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-drive-transfer-real-api",
  date: "2026-09-23",
  time: "16:30",
  title: "Google offboards: Drive ownership transfer actually happens now (runner 1.140.0)",
  items: [
    "The offboard's Drive transfer to transferTarget called an address Google doesn't have - the error was swallowed and the step still said \"transferred Drive ownership\", so no Drive was ever moved",
    "It now uses Google's Data Transfer API, and the step says it REQUESTED the transfer (Google runs it in the background) with Google's status",
    "It needs one more domain-wide delegation scope, admin.datatransfer, asked for in a separate token only when a transfer is due - a domain without it keeps working, and the offboard warns that the Drive was NOT transferred and to do it by hand. The Google help page lists the scope",
    "Any other reason the transfer can't be requested (the target doesn't exist, Google refuses it) is also a warning with Google's reason, never a success line",
  ],
};
