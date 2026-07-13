// LLM-backed runbook extraction. The heuristic parseRunbookText needs headers followed by bullets;
// real ServiceNow KBs often have headings followed by prose paragraphs (and a Table of Contents),
// which the heuristic mis-parses. This asks Azure OpenAI to return clean, ordered sections each
// mapped to a known system key. Returns null when Azure isn't configured or the call fails, so the
// caller can fall back to the heuristic parser.
import { CATALOG, headerToSystemKey, systemHasNameRules, textMentionsSystem } from "../generator/system-map";
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "../generator/llm";
import { parseRunbookText, type ParsedSection } from "./runbook-parse";

const KNOWN = new Set(Object.keys(CATALOG));

export async function extractRunbookAI(text: string, action: "onboard" | "offboard"): Promise<ParsedSection[] | null> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg) || !text.trim()) return null;

  // The model intermittently merges or drops tail sections from the SAME input (observed on DCG's
  // offboard KB: 9 vs 14 sections across runs at temperature 0). The heuristic section count is a
  // cheap lower-bound sanity check — when the extract comes back clearly under it, ask once more
  // and keep the richer answer. (The heuristic over-splits some docs, so allow slack before
  // spending a second call.)
  const baseline = parseRunbookText(text).length;
  const first = await extractOnce(cfg, text, action);
  if (first && first.length + 2 >= baseline) return first;
  const second = await extractOnce(cfg, text, action);
  if (!first) return second;
  if (!second) return first;
  return second.length > first.length ? second : first;
}

async function extractOnce(
  cfg: ReturnType<typeof azureConfigFromEnv>,
  text: string,
  action: "onboard" | "offboard"
): Promise<ParsedSection[] | null> {

  const system = `You convert a Coretelligent IT ${action === "offboard" ? "offboarding" : "onboarding"} runbook into structured JSON sections.
Create ONE section per distinct system, tool, or major phase of work — e.g. ServiceNow, Microsoft 365, Mimecast, Adobe, Case Resolution. Microsoft 365 is its OWN section even when it contains many sub-steps (create user, licensing, groups, Entra app assignments).
Map each section to EXACTLY ONE systemKey from this list, or null if none fits:
${[...KNOWN].join(", ")}.
Rules:
- IGNORE any "Table of Contents" or navigation list — those are not sections.
- Map a systemKey ONLY when the section is that exact product. NEVER map a similar or competing product to a near-miss key (Dashlane is NOT 1password; Barracuda is NOT mimecast) — use null for products not in the list.
- Include EVERY section, including optional ones. NEVER drop a system. If a section is conditional (e.g. "if requested", "only for <client>"), keep that qualifier in the "title" (e.g. "Adobe (if requested)").
- Do NOT merge two different systems into one section. Keep them in the original top-to-bottom order.
- "title" = the heading. "steps" = the concrete actions under it, each a short line; nest sub-steps with two leading spaces per level. Do not invent steps.
Return STRICT JSON of the form: {"sections":[{"title":"Microsoft 365","systemKey":"m365","steps":["Create the user","  Assign E1 license"]},{"title":"Adobe (if requested)","systemKey":"adobe","steps":["..."]}]}`;

  const raw = await azureChatJson(cfg, system, text.slice(0, 12000), 4000);
  const arr = raw && Array.isArray((raw as { sections?: unknown }).sections) ? ((raw as { sections: unknown[] }).sections) : null;
  if (!arr) return null;

  const sections: ParsedSection[] = [];
  for (const s of arr) {
    const sec = s as { title?: unknown; systemKey?: unknown; steps?: unknown };
    const title = typeof sec.title === "string" ? sec.title.trim() : "";
    if (!title) continue;
    let systemKey = typeof sec.systemKey === "string" && KNOWN.has(sec.systemKey) ? sec.systemKey : null;
    const steps = Array.isArray(sec.steps)
      ? sec.steps.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.replace(/\s+$/, ""))
      : [];
    // The model sometimes maps an unlisted product to its nearest listed competitor (Dashlane ->
    // "1password"). Sanity-check its key against the section text — but only for keys that HAVE
    // name rules (mdm/avd/notify don't; for those the model is the only signal, so trust it):
    //  - title matches a DIFFERENT rule and nothing substantiates the model's key -> the rule wins
    //    (a "KnowBe4" title keyed to zoom); if the section DOES name the model's key, keep it (a
    //    "Microsoft 365 / Entra app assignments" section correctly keyed to entra).
    //  - no rule matches the title and nothing substantiates the key -> near-miss hallucination.
    if (systemKey && systemHasNameRules(systemKey)) {
      const fromTitle = headerToSystemKey(title);
      const substantiated = textMentionsSystem(systemKey, `${title}\n${steps.join("\n")}`);
      if (fromTitle && fromTitle !== systemKey && !substantiated) systemKey = fromTitle;
      else if (!fromTitle && !substantiated) systemKey = null;
    }
    sections.push({ seq: sections.length, systemKey, title, status: systemKey ? "automated" : "unmodeled", steps });
  }
  return sections.length ? sections : null;
}
