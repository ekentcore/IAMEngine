// Pure helpers for the document-versioning + AI-update flow. No DB, no I/O — unit-tested directly.
import type { ChangelogEntry } from "@/lib/changelog/entries";

// ── Version numbers ──────────────────────────────────────────────────────────
// Versions are "major.minor". An AI update is a minor bump (1.0 → 1.1); a reviewer can promote a
// draft to a major bump (1.4 → 2.0) when the rewrite is substantial. An unparseable current value
// is treated as 1.0 so the next is always well-formed.
export type VersionBump = "minor" | "major";

export function parseVersion(v: string | null | undefined): { major: number; minor: number } {
  const m = /^(\d+)\.(\d+)$/.exec((v ?? "").trim());
  if (!m) return { major: 1, minor: 0 };
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function nextVersion(current: string | null | undefined, bump: VersionBump = "minor"): string {
  const { major, minor } = parseVersion(current);
  return bump === "major" ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

// Order two "major.minor" strings — used to pick the current published version and to keep the
// version table sorted newest-first. Returns >0 when a is newer than b.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return pa.major !== pb.major ? pa.major - pb.major : pa.minor - pb.minor;
}

// ── Change-log window ────────────────────────────────────────────────────────
// The entries an AI update should consider: everything shipped AFTER the date already folded into
// the current version (its `changelogThrough`). Null/absent means "the whole log" (a first update).
// Comparison is lexical on the ISO YYYY-MM-DD date, which orders correctly. Returned newest-first
// (the input is already newest-first).
export function changelogSince(entries: ChangelogEntry[], throughDate: string | null | undefined): ChangelogEntry[] {
  const since = (throughDate ?? "").trim();
  if (!since) return [...entries];
  return entries.filter((e) => e.date > since);
}

// The newest date present in a set of entries (to stamp onto the version we produce). Null when the
// set is empty. ISO dates compare lexically.
export function newestDate(entries: ChangelogEntry[]): string | null {
  return entries.reduce<string | null>((max, e) => (max === null || e.date > max ? e.date : max), null);
}

// A compact plain-text rendering of the change-log window for the model prompt — one dated block per
// entry, its title, then its bullets. Deliberately plain (no markdown) so it reads as source data,
// not as content to copy.
export function changelogForPrompt(entries: ChangelogEntry[]): string {
  return entries
    .map((e) => {
      const when = e.time ? `${e.date} ${e.time}` : e.date;
      const bullets = e.items.map((i) => `  - ${i}`).join("\n");
      return `[${when}] ${e.title}\n${bullets}`;
    })
    .join("\n\n");
}

// ── Parsing the model's reply ────────────────────────────────────────────────
// We ask the model to answer with a change note, then the full updated document between two
// sentinels — NOT as JSON, because JSON-escaping a 40 KB markdown body (with its own quotes,
// backslashes and newlines) is exactly where a model truncates or mis-escapes. Sentinels are
// robust: we slice between them and never parse the body.
export const DOC_BEGIN = "===BEGIN UPDATED DOCUMENT===";
export const DOC_END = "===END UPDATED DOCUMENT===";
export const NOTE_PREFIX = "CHANGE-NOTE:";

export type ParsedUpdate = { markdown: string; changeNote: string };

export function parseModelUpdate(text: string): ParsedUpdate {
  const raw = text ?? "";
  const begin = raw.indexOf(DOC_BEGIN);
  const end = raw.indexOf(DOC_END);

  // The document sits between the two sentinels. If either is missing the model didn't follow the
  // contract; fall back to treating the whole reply as the document so nothing is silently lost —
  // the reviewer still sees it (and the diff) before it can publish.
  let markdown: string;
  if (begin !== -1 && end !== -1 && end > begin) {
    markdown = raw.slice(begin + DOC_BEGIN.length, end).trim();
  } else {
    markdown = raw.trim();
  }

  // The change note is the CHANGE-NOTE: line(s) before the document sentinel.
  const noteStart = raw.indexOf(NOTE_PREFIX);
  let changeNote = "";
  if (noteStart !== -1) {
    const noteEnd = begin !== -1 && begin > noteStart ? begin : raw.length;
    changeNote = raw.slice(noteStart + NOTE_PREFIX.length, noteEnd).trim();
  }
  return { markdown, changeNote };
}
