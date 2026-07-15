// Render a document's Markdown to HTML — both for the on-page view and the standalone .html
// download. One renderer feeds both so they can't drift.
import { marked } from "marked";

export type VersionRow = {
  version: string;
  date: string; // display date (published date, or "—")
  changeNote: string;
  author: string;
};

// Our documents are authored by us and by the model; they don't contain raw HTML. This strips the
// handful of vectors that would matter if a future update ever introduced some (script/style/event
// handlers/javascript: URLs) — defence in depth, not the primary control (the content is trusted
// and the page is behind auth).
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

// Markdown → sanitized HTML fragment (GFM: tables, fenced code, autolinks). Synchronous — we use no
// async marked extensions.
export function markdownToHtml(md: string): string {
  const html = marked.parse(md ?? "", { gfm: true, breaks: false, async: false }) as string;
  return sanitizeHtml(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

// The version-history table rendered as HTML (used on the page and in the .html download). Rows are
// expected newest-first.
export function versionTableHtml(rows: VersionRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.version)}</td><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.author)}</td><td>${escapeHtml(r.changeNote || "—")}</td></tr>`
    )
    .join("");
  return `<table class="version-table"><thead><tr><th>Version</th><th>Date</th><th>By</th><th>What changed</th></tr></thead><tbody>${body}</tbody></table>`;
}

// A complete, self-contained, theme-aware HTML page for download. Inline CSS only (no external
// requests), prints cleanly to PDF, and carries the version history at the top.
export function styledHtmlDocument(opts: {
  title: string;
  audienceLabel: string;
  version: string;
  bodyHtml: string;
  versionRows: VersionRow[];
}): string {
  const { title, audienceLabel, version, bodyHtml, versionRows } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — v${escapeHtml(version)}</title>
<style>
  :root { --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --bg:#ffffff; --accent:#2563eb; --code-bg:#f6f8fa; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e6e6e6; --muted:#9aa3af; --line:#2b2f36; --bg:#111317; --accent:#7aa2ff; --code-bg:#1b1e24; } }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); margin: 0; }
  main { max-width: 820px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  h3 { font-size: 17px; margin: 24px 0 6px; }
  h4 { font-size: 15px; margin: 18px 0 4px; }
  p, li { color: var(--ink); }
  a { color: var(--accent); }
  code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
  pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: var(--code-bg); }
  blockquote { border-left: 3px solid var(--line); margin: 12px 0; padding: 2px 14px; color: var(--muted); }
  .doc-meta { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; font-size: 12px; color: var(--muted); }
  .version-table { font-size: 13px; }
  .section-label { text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; color: var(--muted); margin: 32px 0 6px; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="doc-meta"><span class="badge">${escapeHtml(audienceLabel)}</span> &nbsp; Version ${escapeHtml(version)}</p>
  <div class="doc-body">${bodyHtml}</div>
  <div class="section-label">Version history</div>
  ${versionTableHtml(versionRows)}
</main>
</body>
</html>`;
}
