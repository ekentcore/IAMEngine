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
    // whole style/script blocks drop — some KBs inline a stylesheet, which otherwise becomes
    // pages of CSS "steps" and starves the AI extractor's input window
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/li|\/ul|\/ol)[^>]*>/gi, "\n")
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
    // ServiceNow nests blocks inside list items (<li>\n<p>text</p></li>), which decodes to an
    // orphan "- " line with its text on the NEXT line — rejoin them so a bullet is one line.
    // ONE newline only: across a blank line the following text is the next section's header, not
    // this bullet's content (an empty <li> before a header must not swallow the header). Nor when
    // the next line is itself a bullet (an empty <li> must not swallow its sibling).
    .replace(/(^|\n)([ \t]*)-[ \t]*\n[ \t]*(?=[^-\s])/g, "$1$2- ")
    // any bullet still empty after the rejoin was a genuinely empty <li> — drop the noise line
    .replace(/(^|\n)[ \t]*-[ \t]*(?=\n|$)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type KbRow = {
  number?: { display_value?: string };
  short_description?: { display_value?: string };
  text?: { display_value?: string; value?: string };
  workflow_state?: { value?: string; display_value?: string };
  latest?: { value?: string };
  sys_updated_on?: { value?: string; display_value?: string };
};

const truthy = (v?: string) => v === "true" || v === "1";

export async function fetchKbArticle(config: SnConfig, number: string, fetcher: Fetcher = fetch): Promise<KbArticle | null> {
  // A KB number is KB + digits, and nothing else. ServiceNow parses `^` and `=` in sysparm_query as
  // operators, so an unvalidated number could widen the query and hand back an unrelated article's
  // body — which the import would then save as the client's runbook. The operator-facing route
  // validates its input; validating HERE means every caller inherits it (the import passes a number
  // discovered from ServiceNow, which is trusted-ish, but this is the one place it can be enforced
  // once).
  const kb = number.trim().toUpperCase();
  if (!/^KB\d{4,12}$/.test(kb)) return null;
  // kb_knowledge keeps EVERY revision as its own row under the SAME number (a KB updated 7 times =
  // 7 rows). Without a version filter, `limit 1` returns an arbitrary — often OUTDATED — revision,
  // so the runbook can show stale licenses/steps. Pull the candidates newest-first and pick the live
  // published one (latest=true, else workflow_state=published), falling back to the most recent.
  const rows = await snGet<Array<KbRow>>(
    config,
    "/api/now/table/kb_knowledge",
    {
      sysparm_query: `number=${kb}^ORDERBYDESCsys_updated_on`, // the VALIDATED value, not the raw one
      sysparm_fields: "number,short_description,text,workflow_state,latest,sys_updated_on",
      sysparm_display_value: "all",
      sysparm_limit: "25",
    },
    fetcher
  );
  if (rows.length === 0) return null;
  const r =
    rows.find((x) => truthy(x.latest?.value)) ??
    rows.find((x) => (x.workflow_state?.value ?? "").toLowerCase() === "published") ??
    rows[0]; // already newest-first by sys_updated_on
  const html = r.text?.value ?? r.text?.display_value ?? "";
  return {
    number: r.number?.display_value ?? kb,
    title: r.short_description?.display_value ?? "",
    text: htmlToText(html),
  };
}
