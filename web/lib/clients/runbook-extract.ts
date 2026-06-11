// LLM-backed runbook extraction. The heuristic parseRunbookText needs headers followed by bullets;
// real ServiceNow KBs often have headings followed by prose paragraphs (and a Table of Contents),
// which the heuristic mis-parses. This asks Azure OpenAI to return clean, ordered sections each
// mapped to a known system key. Returns null when Azure isn't configured or the call fails, so the
// caller can fall back to the heuristic parser.
import { CATALOG } from "../generator/system-map";
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "../generator/llm";
import type { ParsedSection } from "./runbook-parse";

const KNOWN = new Set(Object.keys(CATALOG));

export async function extractRunbookAI(text: string, action: "onboard" | "offboard"): Promise<ParsedSection[] | null> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg) || !text.trim()) return null;

  const system = `You convert a Coretelligent IT ${action === "offboard" ? "offboarding" : "onboarding"} runbook into structured JSON sections.
Each section is one phase of work — usually one per system or tool (e.g. ServiceNow, Microsoft 365, Mimecast, Case Resolution).
Map each section to EXACTLY ONE systemKey from this list, or null if none fits:
${[...KNOWN].join(", ")}.
Rules:
- IGNORE any "Table of Contents" or navigation list — those are not sections.
- Use the section's heading text as "title".
- "steps" are the concrete actions performed under that heading, each a short line; keep sub-steps nested by prefixing two spaces per level of indentation.
- Preserve the original top-to-bottom order. Do not invent steps that aren't in the text.
Return STRICT JSON of the form: {"sections":[{"title":"Microsoft 365","systemKey":"m365","steps":["Create the user","  Assign E1 license"]}]}`;

  const raw = await azureChatJson(cfg, system, text.slice(0, 12000), 2500);
  const arr = raw && Array.isArray((raw as { sections?: unknown }).sections) ? ((raw as { sections: unknown[] }).sections) : null;
  if (!arr) return null;

  const sections: ParsedSection[] = [];
  for (const s of arr) {
    const sec = s as { title?: unknown; systemKey?: unknown; steps?: unknown };
    const title = typeof sec.title === "string" ? sec.title.trim() : "";
    if (!title) continue;
    const systemKey = typeof sec.systemKey === "string" && KNOWN.has(sec.systemKey) ? sec.systemKey : null;
    const steps = Array.isArray(sec.steps)
      ? sec.steps.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.replace(/\s+$/, ""))
      : [];
    sections.push({ seq: sections.length, systemKey, title, status: systemKey ? "automated" : "unmodeled", steps });
  }
  return sections.length ? sections : null;
}
