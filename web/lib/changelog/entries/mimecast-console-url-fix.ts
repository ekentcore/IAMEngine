import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mimecast-console-url-fix",
  date: "2026-07-21",
  time: "08:30",
  title: "Mimecast guided setup opens the right console",
  items: [
    "The \"Open console\" link in the Setup Mimecast API flow pointed at login.services.mimecast.com, which is not the Administration Console sign-in - it now opens login.mimecast.com",
  ],
};
