import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "readiness-wired-untested-clarity",
  date: "2026-07-19",
  time: "16:45",
  title: "Readiness \"partial\" summary no longer reads as a bare 0 of N",
  items: [
    "A client with every credentialed system wired but nothing conn-tested ok yet showed the amber \"partial\" badge with a summary of \"0 of N ready\" - the wired count that actually explains the amber (systemsWired, not systemsReady) was invisible",
    "The partial-branch summary in computeClientReadiness() now leads with the wired count alongside the ready count, so \"0 of N ready\" always sits next to \"N wired\" instead of reading as a bare zero",
    "Presentation only: the not_set_up vs partial tier split still keys off systemsWired, unchanged",
    "Added a readiness.test.ts case for systemsReady === 0 && systemsWired > 0, a boundary that had no explicit test before",
  ],
};
