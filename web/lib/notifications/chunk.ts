// Splitting long chat messages under Zoom's real cap. Lives with the notifications transport because
// the limit is a property of the TRANSPORT, not of any one report — sender.ts guards every Zoom send
// with it, and report builders (lib/audits/m365-fleet-report) pre-chunk with it.
//
// Zoom's cap on a chat message is 4000 characters — their own answer said 4096 first and was later
// CORRECTED to 4000, and a report split against 4096 verifiably arrived with its tail silently cut
// off mid-list (2026-07-17 fleet report). Zoom does not document whether it counts characters or
// bytes, and our text is full of multibyte punctuation ("—", "·"), so the budget is measured in
// UTF-8 BYTES with margin: a message of ≤3800 bytes fits the cap under either reading (chars ≤ bytes).
// The budget is per MESSAGE and the title rides in the same payload (sender.messageText prepends
// it), so the title's cost comes out of each chunk's allowance.
export const ZOOM_MESSAGE_BUDGET = 3800;
export const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

// Hard-cut a string to fit `maxBytes` UTF-8 bytes including a trailing ellipsis. Binary search on the
// slice length: a cut can land inside a surrogate pair, which encodes as a 3-byte replacement — ugly
// in one pathological string, but never over budget.
export const cutToBytes = (s: string, maxBytes: number): string => {
  const room = Math.max(0, maxBytes - utf8Len("…"));
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Len(s.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
};

// Split lines into chunks whose rendered "title\nline\nline…" stays under `limit`.
//
// `titleFor(i, total)` is a callback rather than a string because the title carries the "(2/5)"
// counter — which depends on the total, which is not known until the split is done. That is circular:
// the title's width comes out of each chunk's budget, so a wider title makes more chunks, and more
// chunks make a wider counter ("9/9" → "9/10").
//
// Two passes do NOT settle this. Splitting for "Report" (6 chars) can yield 9 chunks; re-splitting for
// "Report 9/9" (10) can then yield 10, whose real titles are "Report 4/10" (11) — one wider than the
// budget they were split against, so every full chunk lands 1 char over and Zoom rejects it. So:
// iterate to a fixed point, where the width we split against is at least the width the resulting
// count actually needs. Each round strictly widens, and the width only grows with the counter's digit
// count, so it settles in a couple of rounds.
//
// `keepWithNext(line)`: a line (e.g. a section heading) that must not be stranded as the last line of
// a message — it only starts a chunk if its following line fits there too. Callers with no headings
// pass nothing.
export function chunkLines(
  lines: readonly string[],
  titleFor: (i: number, total: number) => string,
  limit: number = ZOOM_MESSAGE_BUDGET,
  keepWithNext: (line: string) => boolean = () => false
): { title: string; detail: string }[] {
  const split = (titleWidth: number): string[][] => {
    const chunks: string[][] = [];
    let cur: string[] = [];
    let size = 0;
    const fitted = lines.map((raw) => {
      // A single line longer than the whole budget can never fit; hard-cut it rather than emit a
      // message the transport will reject outright.
      const room = limit - titleWidth - 1;
      return utf8Len(raw) > room ? cutToBytes(raw, room) : raw;
    });
    for (const [i, line] of fitted.entries()) {
      const cost = utf8Len(line) + 1; // +1 for the newline joining it to what precedes
      // A heading stranded as the last line of a message leaves the next message a wall of rows with
      // nothing saying what they are — and chat does not guarantee the two stay adjacent. So a
      // heading only starts here if its first row fits here too.
      const next = fitted[i + 1];
      const need = keepWithNext(line) && next !== undefined ? cost + utf8Len(next) + 1 : cost;
      if (cur.length && size + need > limit - titleWidth) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(line);
      size += cost;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  };

  // The widest title any of `total` chunks will carry. Measured over every index, not just the first
  // and last, so a titleFor that is not monotonic in `i` cannot slip a wider title past the budget.
  const maxTitleWidth = (total: number): number => {
    let w = 0;
    for (let i = 0; i < Math.max(1, total); i++) w = Math.max(w, utf8Len(titleFor(i, total)));
    return w;
  };

  let width = maxTitleWidth(1);
  let chunks = split(width);
  let settled = false;
  for (let round = 0; round < 8; round++) {
    const need = maxTitleWidth(chunks.length);
    if (need <= width) { settled = true; break; }
    width = need;
    chunks = split(width);
  }
  // Belt and braces: if it somehow hasn't settled, split against the width for the worst case there
  // is — one chunk per line, which no split can exceed. Guaranteed to fit, at the cost of a slightly
  // narrower body. Being a character over the limit is silent non-delivery; being under is invisible.
  if (!settled && maxTitleWidth(chunks.length) > width) chunks = split(maxTitleWidth(Math.max(1, lines.length)));

  return chunks.map((c, i) => ({ title: titleFor(i, chunks.length), detail: c.join("\n") }));
}
