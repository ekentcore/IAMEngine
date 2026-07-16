import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-convert-by-default",
  date: "2026-07-16",
  time: "14:30",
  title: "55 clients could never have a leaver's licence removed — every offboard left the seat billing, and it looked like caution",
  items: [
    "Offboards keep the licence until the mailbox is converted to shared, because pulling it off an unconverted mailbox lets Exchange delete the mail after 30 days. But for 55 clients nothing was ever configured to convert — so the licence waited for something that would never happen, on every offboard, forever. The warning read like ordinary caution, so nobody chased it",
    "That is the exact cost the July sweep was written to reclaim, in its worst form: seat still paid for AND nothing converted. Easterseals' offboard this afternoon is what surfaced it",
    "Cause: the sweep only configured a conversion when the client's runbook happened to mention a shared mailbox — but it moved the licence removal to the later step regardless. A runbook that says \"remove the licence\" and stops isn't choosing to delete the mail; it predates anyone thinking about the mailbox at all",
    "Converting is now the default wherever we remove a licence. It costs nothing — a shared mailbox under the cap needs no licence — so the seat comes back AND the mail is kept",
    "A mailbox over the cap genuinely can't be converted (that big, it needs a licence either way), so the run now ASKS instead of guessing: keep the licence and the mail, or remove it knowing the mail will be lost. Same decision as before, but now it's a button on the case rather than a warning waiting for someone to own it",
    "A client that really does want the mailbox gone can say so once, and the licence comes off without a conversion — with the run stating plainly that the mail will be purged",
    "Also fixed: the button that records these answers only ever looked at the 365 step, while the licence for these clients lives on the Entra step. It would have reported success and changed nothing",
  ],
};
