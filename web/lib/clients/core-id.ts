// CORE id parsing. Pure — no Prisma, no ServiceNow — so the browser can use the SAME parser the
// server does: the import dialog's progress count and the route's work list must agree, or the
// button counts to "2/3" and stops.

// "CORE1269", "core1269", "core 1269", "CORE-1269" and a bare "1269" are all the same id — that is
// how the team writes it in tickets and chat. Anything else is junk and must not reach ServiceNow.
export function normalizeCoreId(raw: string): string | null {
  const v = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = /^(?:CORE[-_]?)?(\d+)$/.exec(v);
  return m ? `CORE${m[1]}` : null; // digits kept verbatim — the id is a string, "01269" != "1269"
}

// The textarea parser: ids separated by commas (or any whitespace/semicolons — paste is messy).
// De-duplicates on the NORMALIZED id, so "CORE1269, core1269" is one import, not two.
export function parseCoreIds(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  // Close up "CORE 1269" FIRST: splitting on whitespace would otherwise tear it into a junk "CORE"
  // token and a bare "1269", reporting an error for an id the operator wrote perfectly reasonably.
  const glued = (text ?? "").replace(/\bcore[\s_-]+(?=\d)/gi, "CORE");
  for (const token of glued.split(/[,;\s]+/)) {
    const t = token.trim();
    if (!t) continue;
    const id = normalizeCoreId(t);
    if (!id) {
      if (!invalid.includes(t)) invalid.push(t);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, invalid };
}
