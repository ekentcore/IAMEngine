import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fix-edge-crypto-build-crash",
  date: "2026-07-23",
  time: "10:45",
  title: "Fixed a startup crash that took the app down after the per-agent runner auth change",
  items: [
    "Fixed a build crash (\"node:crypto is not handled\") that stopped the app from starting: the Edge middleware was pulling the Node-only token crypto into its bundle. Split the crypto-free token helpers into their own module so the middleware no longer imports node:crypto.",
  ],
};
