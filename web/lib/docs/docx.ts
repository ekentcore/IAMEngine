// Markdown → a real Word .docx, so the client hand-off document matches the originals these were
// seeded from. We walk marked's token stream (the same parser render.ts uses for HTML) and map each
// block to a docx element. The version-history table is inserted right after the title heading.
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ISectionOptions,
} from "docx";
import { marked, type Token, type Tokens } from "marked";
import type { VersionRow } from "./render";

const HEADING = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const LINK_COLOR = "2563EB";
const CODE_FONT = "Courier New";

// Inline tokens (bold, italic, code, links, plain text) → docx runs.
function inlineRuns(tokens: Token[] | undefined, base: { bold?: boolean; italics?: boolean } = {}): TextRun[] {
  if (!tokens?.length) return [];
  const runs: TextRun[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "strong":
        runs.push(...inlineRuns((t as Tokens.Strong).tokens, { ...base, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns((t as Tokens.Em).tokens, { ...base, italics: true }));
        break;
      case "codespan":
        runs.push(new TextRun({ text: (t as Tokens.Codespan).text, font: CODE_FONT, ...base }));
        break;
      case "link":
        runs.push(new TextRun({ text: (t as Tokens.Link).text, color: LINK_COLOR, underline: {}, ...base }));
        break;
      case "br":
        runs.push(new TextRun({ text: "", break: 1 }));
        break;
      case "del":
        runs.push(...inlineRuns((t as Tokens.Del).tokens, base));
        break;
      default: {
        const text = (t as { text?: string }).text ?? "";
        if (text) runs.push(new TextRun({ text, ...base }));
      }
    }
  }
  return runs;
}

function textRunsFromCell(cell: Tokens.TableCell): TextRun[] {
  const runs = inlineRuns(cell.tokens);
  return runs.length ? runs : [new TextRun(cell.text ?? "")];
}

function docxTable(t: Tokens.Table): Table {
  const header = new TableRow({
    tableHeader: true,
    children: t.header.map(
      (c) => new TableCell({ children: [new Paragraph({ children: textRunsFromCell(c).map((r) => r) })], shading: { fill: "F3F4F6" } })
    ),
  });
  const rows = t.rows.map(
    (row) => new TableRow({ children: row.map((c) => new TableCell({ children: [new Paragraph({ children: textRunsFromCell(c) })] })) })
  );
  return new Table({ rows: [header, ...rows], width: { size: 100, type: WidthType.PERCENTAGE } });
}

// A markdown list → a flat array of bulleted/numbered paragraphs (one nesting level; deeper items
// are flattened, which is fine for these documents).
function listParagraphs(list: Tokens.List): Paragraph[] {
  return list.items.map((item, i) => {
    const runs = inlineRuns(item.tokens?.flatMap((tk) => ("tokens" in tk && tk.tokens ? tk.tokens : [tk])) as Token[]);
    const children = runs.length ? runs : [new TextRun(item.text ?? "")];
    return new Paragraph(
      list.ordered
        ? { children, numbering: { reference: "doc-ol", level: 0 } }
        : { children, bullet: { level: 0 } }
    );
  });
}

// A single block token → zero or more docx elements.
function blockToElements(token: Token): (Paragraph | Table)[] {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      return [new Paragraph({ heading: HEADING[Math.min(h.depth, 6) - 1], children: inlineRuns(h.tokens) })];
    }
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return [new Paragraph({ children: inlineRuns(p.tokens), spacing: { after: 120 } })];
    }
    case "list":
      return listParagraphs(token as Tokens.List);
    case "table":
      return [docxTable(token as Tokens.Table)];
    case "code": {
      const c = token as Tokens.Code;
      return c.text.split("\n").map((line) => new Paragraph({ children: [new TextRun({ text: line || " ", font: CODE_FONT })], shading: { fill: "F6F8FA" } }));
    }
    case "blockquote": {
      const b = token as Tokens.Blockquote;
      return [new Paragraph({ children: inlineRuns(b.tokens as Token[]), indent: { left: 360 }, spacing: { after: 120 } })];
    }
    case "hr":
      return [new Paragraph({ border: { bottom: { style: "single", size: 6, color: "CCCCCC", space: 1 } }, children: [] })];
    case "space":
      return [];
    default: {
      const text = (token as { text?: string }).text?.trim();
      return text ? [new Paragraph({ children: [new TextRun(text)] })] : [];
    }
  }
}

function versionHistoryTable(rows: VersionRow[]): Table {
  const head = new TableRow({
    tableHeader: true,
    children: ["Version", "Date", "By", "What changed"].map(
      (h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })], shading: { fill: "F3F4F6" } })
    ),
  });
  const body = rows.map(
    (r) =>
      new TableRow({
        children: [r.version, r.date, r.author, r.changeNote || "—"].map((v) => new TableCell({ children: [new Paragraph({ children: [new TextRun(v)] })] })),
      })
  );
  return new Table({ rows: [head, ...body], width: { size: 100, type: WidthType.PERCENTAGE } });
}

export async function markdownToDocxBuffer(opts: {
  title: string;
  audienceLabel: string;
  version: string;
  markdown: string;
  versionRows: VersionRow[];
}): Promise<Buffer> {
  const tokens = marked.lexer(opts.markdown ?? "");
  const children: (Paragraph | Table)[] = [];

  // Emit the body, and once past the first heading (the document title), inject the meta line and
  // the version-history table so they sit directly under the title.
  let injected = false;
  const injectMeta = () => {
    children.push(new Paragraph({ children: [new TextRun({ text: `${opts.audienceLabel}  ·  Version ${opts.version}`, color: "6B7280" })], spacing: { after: 160 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: "VERSION HISTORY", bold: true, size: 18, color: "6B7280" })], spacing: { before: 120, after: 80 } }));
    children.push(versionHistoryTable(opts.versionRows));
    children.push(new Paragraph({ children: [], spacing: { after: 160 } }));
    injected = true;
  };

  const hasHeading = tokens.some((t) => t.type === "heading");
  if (!hasHeading) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(opts.title)] }));
    injectMeta();
  }
  for (const token of tokens) {
    children.push(...blockToElements(token));
    if (!injected && token.type === "heading") injectMeta();
  }

  const section: ISectionOptions = { properties: {}, children };
  const doc = new Document({
    numbering: { config: [{ reference: "doc-ol", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }] }] },
    sections: [section],
  });
  return Packer.toBuffer(doc);
}
