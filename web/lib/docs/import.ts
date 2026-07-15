// Import an edited copy of a document back into the app. Staff download a doc (.docx or .md), edit
// it locally, and upload it as the next reviewed draft. A .md download is our canonical body already,
// so it's taken as-is; a .docx is converted back to Markdown (mammoth → HTML → turndown) and then has
// the title-meta line + version-history section our downloads inject stripped, so a round-trip does
// not bake that chrome into the body.
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export type UploadFormat = "docx" | "md";

// Map a filename to a supported format, or null for anything we don't accept. (.txt/.markdown are
// treated as Markdown for convenience.)
export function detectFormat(filename: string): UploadFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "md";
  return null;
}

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", hr: "---" });
  td.use(gfm); // tables + strikethrough, matching the GFM our renderer emits
  return td;
}

export function htmlToMarkdown(html: string): string {
  return turndown().turndown(html ?? "").trim();
}

const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSeparator = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes("-");
// The exact meta line our downloads inject: "<audience label> · Version <x.y>", where the label is
// one of the two AUDIENCE_LABEL values (see lib/docs/store.ts). Anchored to those exact labels and a
// dotted version so a real content line like "Adobe Sign · Version 2" is never mistaken for chrome.
const metaLineRe = /^\s*(Client-facing|Internal — staff only)\s*·\s*Version\s+\d+\.\d+\s*$/;
// The exact header of the injected version-history table, in order: Version | Date | By | What changed.
const VERSION_HISTORY_HEADER = ["version", "date", "by", "what changed"];
// "Version history" as a heading (# …) or a bold/plain label paragraph (**…**).
const versionHistoryLabelRe = /^\s*#*\s*\**\s*version history\s*\**\s*$/i;

// Remove the chrome our .docx/.html downloads add around the body: the audience/version meta line,
// the "Version history" label, and the version-history table (a GFM table whose header is
// Version | Date | By | What changed). Pure + unit-tested. The document's own title heading and any
// real content tables are preserved.
export function stripDownloadChrome(md: string): string {
  const lines = (md ?? "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (versionHistoryLabelRe.test(line)) continue;
    if (metaLineRe.test(line)) continue;

    // A GFM table: a pipe row followed by a separator row. If its header is the version-history
    // header, drop the whole block; otherwise keep it verbatim.
    if (isTableLine(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      let j = i;
      while (j < lines.length && isTableLine(lines[j])) j++;
      const header = line.split("|").map((c) => c.replace(/[*_`#]/g, "").trim().toLowerCase()).filter(Boolean);
      const isVersionHistory = header.length === VERSION_HISTORY_HEADER.length && header.every((c, k) => c === VERSION_HISTORY_HEADER[k]);
      if (!isVersionHistory) for (let k = i; k < j; k++) out.push(lines[k]);
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// mammoth wraps each table cell's content in <p>, which turndown's GFM table rule renders as
// block-level text (newlines inside cells) and breaks the Markdown table. Unwrap paragraphs inside
// <td>/<th> to inline content — multiple paragraphs in one cell join with a space (rare for these
// documents; cells are single-line).
function inlineTableCells(html: string): string {
  return html.replace(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi, (_m, tag: string, attrs: string, inner: string) => {
    const flat = inner.replace(/<\/p>\s*<p[^>]*>/gi, " ").replace(/<\/?p[^>]*>/gi, "").trim();
    return `<${tag}${attrs}>${flat}</${tag}>`;
  });
}

export async function docxToMarkdown(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return stripDownloadChrome(htmlToMarkdown(inlineTableCells(html)));
}

// Convert an uploaded file to our canonical Markdown. Throws on an unsupported extension or an empty
// result (a corrupt/blank file), so the caller can surface a clear error rather than creating an
// empty draft.
export async function importToMarkdown(filename: string, buffer: Buffer): Promise<{ markdown: string; format: UploadFormat }> {
  const format = detectFormat(filename);
  if (!format) throw new Error("unsupported file type — upload a .docx or .md file");
  const markdown = format === "md" ? buffer.toString("utf8").trim() : await docxToMarkdown(buffer);
  if (!markdown.trim()) throw new Error("the uploaded file had no readable content");
  return { markdown, format };
}
