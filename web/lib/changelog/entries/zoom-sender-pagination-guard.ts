import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "zoom-sender-pagination-guard",
  date: "2026-07-17",
  time: "11:30",
  title: "Every Zoom message is now length-guarded - long messages arrive as (x of y) pages",
  items: [
    "Until now only the fleet report pre-split its messages; any OTHER Zoom message over the cap silently lost its tail in the room while the send still reported ok",
    "Every Zoom send now checks the 3800-byte budget: a message that fits goes out exactly as before, and one that doesn't is split into sequential messages titled '<title> (x of y)' - no counter when it's a single message",
    "Parts send in order with a small gap (numbered pages must not race), every part is attempted even if one fails, and the error names exactly which page didn't arrive",
    "The splitter (fixed-point title budgeting, UTF-8 byte measuring, heading handling) moved from the fleet-report module to the notifications transport where the limit actually lives - the report now uses the shared one",
  ],
};
