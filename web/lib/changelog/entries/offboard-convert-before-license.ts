import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-convert-before-license",
  date: "2026-07-16",
  time: "10:00",
  title: "Offboards now convert the mailbox to shared BEFORE removing the M365 license — every AD client was leaving a paid seat assigned",
  items: [
    "The step order was an ONBOARD order: create in AD, sync, then the cloud steps with Exchange last. On an offboard that is backwards — the mailbox has to be converted to shared while the account still holds its license. So the license step ran first, correctly refused to strip a license off an unconverted mailbox, warned \"re-run once the mailbox step is done\", and nothing ever re-ran it. The seat stayed assigned and billing, on every offboard for a client that converts mailboxes",
    "Offboards now run Exchange before Entra/M365, so the license comes off in the same pass. Onboards are unchanged. Some client profiles had already declared this order correctly and the planner was silently throwing that setting away",
    "A mailbox over the 50 GB threshold still keeps its license and warns — unchanged, and now it's the only reason a license stays",
    "A hybrid (on-prem) mailbox converts on-prem and only becomes shared in the cloud after a directory sync. The runner used to report \"converted\" the instant it submitted that change, so a re-run could remove the license while the cloud mailbox was still a user mailbox — which lets Exchange delete the mail after its 30-day grace. It now reads the mailbox back and only reports a convert once the cloud confirms it",
    "A mailbox whose size couldn't be read was treated as 0 GB — sailing through both 50 GB guards. A 200 GB mailbox whose size read got throttled would be converted AND unlicensed, leaving it locked and inaccessible. An unreadable size is now reported as unknown and stops the convert",
    "A client whose profile says \"don't convert this mailbox\" was having it converted anyway, and a leaver whose Exchange step was skipped got a warning telling them to re-run \"once the mailbox step is done\" — a step that was never going to run. Both fixed",
    "Needs runner 1.65.0",
  ],
};
