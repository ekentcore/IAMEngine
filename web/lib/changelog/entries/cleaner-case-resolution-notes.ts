import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "cleaner-case-resolution-notes",
  date: "2026-08-05",
  time: "13:30",
  title: "Case resolution notes are readable: one action per line, and the runner's asides trimmed",
  items: [
    "The note that lands on the ticket was one wall of semicolons — a single Microsoft 365 step ran to twenty clauses on one line, and you couldn't see what had actually been done. Every action now gets its own line: the first rides the step line, the rest are indented beneath it, so a step is still one scannable block. (FR #0000046)",
    "The runner's explanatory tails are trimmed: \"distribution/mail-enabled 'DrakeStar - USA' — added by the Exchange step (Graph can't); not present yet\" becomes \"distribution/mail-enabled 'DrakeStar - USA'\". Those asides earn their space in the run log, where an engineer is reading a failure; on a ticket they bury the facts",
    "Raw vendor error blobs are cut too — the Mimecast follow-up that used to carry a full POST URL and two chained error strings now reads \"couldn't trigger directory sync\"",
    "Two things the trimming deliberately does NOT do. It never cuts at a hyphen inside a name, so the DL 'DrakeStar - USA' keeps its name (cutting there would have renamed a real distribution list in the permanent record). And it never cuts an em dash inside parentheses, so the password step's \"(change at next sign-in NOT required — operator choice; shown once to the operator, never stored)\" survives intact",
    "Whole action lines are never dropped, even the noisy bookkeeping ones. A missing line reads as \"the engine didn't do it\", which is a worse failure than a long line — so the note gets shorter by trimming, not by omitting. The full untrimmed text stays in the run log and the audit row",
    "Duplicate lines collapse: two actions that differed only in their explanatory tail say the same thing once trimmed, and a repeated bullet reads as the step having done it twice",
    "Covered by 11 new tests in lib/cases/resolution-note.test.ts, including the exact strings from UM0030053 (the case in the request)",
  ],
};
