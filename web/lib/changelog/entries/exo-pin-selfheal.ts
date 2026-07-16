import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exo-pin-selfheal",
  date: "2026-07-15",
  time: "14:30",
  title: "Runner self-heals the Exchange Online module pin",
  items: [
    "Exchange jobs no longer fail with \"does not contain a method named 'GetResponseHeader'\" on hosts that only had the broken ExchangeOnlineManagement 3.10.0 (which puretech/core2104 hit)",
    "The runner now installs the PS7.6-safe 3.9.2 pin at startup when it is missing, instead of warning and silently falling back to the broken build (runner 1.61.0)",
  ],
};
