// Fetch a KB article's body text from ServiceNow (kb_knowledge), stripped to plain text so it can
// feed the same runbook parser as pasted instructions. The "refresh from KB" path: KB edited in SN
// -> fetch here -> operator reviews the parse preview -> save replaces the runbook + re-wires
// systems. Deliberately operator-in-the-loop — a KB edit should never silently rewrite a client.
import type { SnConfig } from "./types";
import { snGet } from "./http";

export type KbArticle = { number: string; title: string; text: string };

type Fetcher = typeof fetch;

// Minimal HTML -> text: block tags become newlines, list items become "- ", tags drop, common
// entities decode. Enough for the runbook parser, which works line-by-line.
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    // Numeric character refs (&#64; -> @, &#43; -> +) — common in ServiceNow's encoded KB HTML,
    // e.g. email addresses come through as jdoe&#64;domain without this.
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchKbArticle(config: SnConfig, number: string, fetcher: Fetcher = fetch): Promise<KbArticle | null> {
  const rows = await snGet<Array<{ number?: { display_value?: string }; short_description?: { display_value?: string }; text?: { display_value?: string; value?: string } }>>(
    config,
    "/api/now/table/kb_knowledge",
    {
      sysparm_query: `number=${number}`,
      sysparm_fields: "number,short_description,text",
      sysparm_display_value: "all",
      sysparm_limit: "1",
    },
    fetcher
  );
  const r = rows[0];
  if (!r) return null;
  const html = r.text?.value ?? r.text?.display_value ?? "";
  return {
    number: r.number?.display_value ?? number,
    title: r.short_description?.display_value ?? "",
    text: htmlToText(html),
  };
}
