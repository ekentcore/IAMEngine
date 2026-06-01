// Heuristic parsing of pasted runbook content -> detected systems + inferred backbone.
// Shared by the KB generator (script) and the in-app "parse instructions" editor mode.
import { headerToSystemKey, inferBackbone } from "./system-map";

export function stripHtml(html: string, max = 6000): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function extractHeaders(html: string): string[] {
  const out: string[] = [];
  const re = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text && text.toLowerCase() !== "table of contents") out.push(text);
  }
  return out;
}

export type ParseResult = {
  systems: string[]; // detected, in first-seen order
  unmodeled: string[]; // headers/labels that didn't map to a known system
  backbone: "entra" | "google" | "ad-synced" | "ad-standalone";
  backboneConfident: boolean;
};

const isHtml = (s: string) => /<(h[1-4]|p|div|ul|table)\b/i.test(s);

// Parse pasted instructions. For HTML we trust section headers; for plain text we scan
// short lines (bullets/headings) — both feed the same header->system mapping.
export function parseInstructions(input: string): ParseResult {
  const systems: string[] = [];
  const unmodeled: string[] = [];
  const add = (label: string) => {
    const key = headerToSystemKey(label);
    if (key) {
      if (!systems.includes(key)) systems.push(key);
    } else if (label.length <= 60 && !unmodeled.includes(label)) {
      unmodeled.push(label);
    }
  };

  if (isHtml(input)) {
    for (const h of extractHeaders(input)) add(h);
  } else {
    for (const line of input.split(/[\r\n]+/)) {
      const t = line.replace(/^[\s\-*#\d.)]+/, "").trim();
      if (t && t.length <= 120) {
        const key = headerToSystemKey(t);
        if (key && !systems.includes(key)) systems.push(key);
      }
    }
  }

  const { backbone, confident } = inferBackbone(new Set(systems));
  return { systems, unmodeled, backbone, backboneConfident: confident };
}
