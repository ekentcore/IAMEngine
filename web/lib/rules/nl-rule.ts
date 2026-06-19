// LLM-assisted "rule drafter": turn a plain-English description into a structured persona/rule draft
// the no-code editor can render, the operator can tweak, and the existing rules grammar/validation
// accept. The LLM only DRAFTS — every condition is re-validated with the real grammar, and group/OU
// names are matched against the client's discovered objects (a guardrail; unmatched names are
// flagged, not trusted). Pure + injectable chat (tests pass a fake; prod uses azureChatJson).
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "../generator/llm";
import { validateCondition } from "../profiles/condition-builder";

export type ChatFn = (system: string, user: string) => Promise<Record<string, unknown> | null>;

export type GroupMatch = { matched: string[]; unmatched: string[] };

export type RuleDraft = {
  kind: "rule" | "persona";
  ruleType: "group" | "ou" | "attribute" | "persona";
  condition: string; // the `when` (rule) or persona `match`; "" = always applies
  conditionValid: boolean;
  conditionError?: string;
  groups?: GroupMatch; // group rule, or a persona's groups
  ou?: { path: string; matched: boolean };
  attribute?: { name: string; value: string };
  personaName?: string;
  titles?: string[];
  explanation: string;
  lowConfidence: boolean;
};

export type GenerateRuleInput = {
  text: string;
  kind: "rule" | "persona";
  action?: "onboard" | "offboard";
  systemKey?: string;
  knownGroups?: string[];
  knownOus?: string[];
  current?: RuleDraft; // when refining
  correction?: string; // a follow-up correction to apply to `current`
};

// The variables a condition can branch on — kept in sync with buildPlanContext (lib/profiles/context.ts)
// and the editor's VARS (condition-builder.tsx). Listed in the prompt so the model uses real fields.
const CONTEXT_VARS = [
  "first", "last", "title", "department", "employmentType", "startDate", "manager", "mobile", "did",
  "extension", "domain", "upn", "username",
  "role.name", "location.name", "location.city", "location.state", "location.zip", "location.timezone",
  "country.short", "country.name", "country.code",
  // free-text intake fields (match with ~= regex):
  "otherNeeds", "otherHardware", "otherSoftware", "installedSoftware", "cloudApplications",
  "needsComputer", "printers", "description",
];

const norm = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

// Split model-suggested names into those that match a discovered object (returned with the real
// casing) and those that don't (flagged for the operator). Empty known list ⇒ nothing to match
// against, so everything passes through as-is (still usable, just unvalidated).
function matchNames(suggested: string[], known: string[]): GroupMatch {
  if (!known.length) return { matched: suggested, unmatched: [] };
  const byNorm = new Map(known.map((k) => [norm(k), k]));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const s of suggested) {
    const hit = byNorm.get(norm(s));
    if (hit) { if (!matched.includes(hit)) matched.push(hit); }
    else if (!unmatched.includes(s)) unmatched.push(s);
  }
  return { matched, unmatched };
}

function buildSystem(input: GenerateRuleInput): string {
  const vars = CONTEXT_VARS.join(", ");
  const grammar = [
    "A CONDITION is terms joined by && (and) / || (or). Each term is `<field> <op> <value>`:",
    "  ==  equals (case-insensitive)   !=  not equals   ~=  regex match (case-insensitive)   in [a, b, c]  one of",
    "Fields are the variables below (dotted ok). For free-text fields (otherNeeds, otherHardware, …) use ~= with a small regex.",
    "HARD LIMIT: a ~= regex value must NOT contain || or && (the grammar splits on those first). Use a single regex like `mac|macbook|apple`.",
    "An empty condition (\"\") means it always applies.",
    `Variables: ${vars}`,
  ].join("\n");

  if (input.kind === "persona") {
    return [
      "You draft a CLIENT PERSONA for an IT onboarding system from a plain-English description.",
      "A persona = a named role with an optional auto-select condition (match), selectable job titles, and groups its members get.",
      grammar,
      input.knownGroups?.length ? `Pick group names ONLY from this list when possible (copy exact text): ${input.knownGroups.join(", ")}` : "",
      'Return STRICT JSON only: { "ruleType": "persona", "personaName": "<short role name>", "match": "<condition or empty>", "titles": ["<job title>"], "groups": ["<group name>"], "explanation": "<one short sentence>", "lowConfidence": <bool> }',
    ].filter(Boolean).join("\n");
  }
  return [
    `You draft ONE conditional RULE for the "${input.systemKey ?? "a"}" system of an IT ${input.action ?? "onboard"} runbook from a plain-English description.`,
    "A rule is one of: a GROUP rule (add the user to groups when a condition holds), an OU rule (place/move the user to an OU when a condition holds), or an ATTRIBUTE rule (set a directory attribute when a condition holds).",
    grammar,
    input.knownGroups?.length ? `Pick group names ONLY from this list when possible (copy exact text): ${input.knownGroups.join(", ")}` : "",
    input.knownOus?.length ? `Pick an OU ONLY from this list when possible: ${input.knownOus.join(" | ")}` : "",
    "Return STRICT JSON only, exactly one of these shapes:",
    '  { "ruleType": "group", "when": "<condition or empty>", "groups": ["<group>"], "explanation": "<sentence>", "lowConfidence": <bool> }',
    '  { "ruleType": "ou", "when": "<condition or empty>", "ou": "<OU path>", "explanation": "<sentence>", "lowConfidence": <bool> }',
    '  { "ruleType": "attribute", "when": "<condition or empty>", "attribute": { "name": "<attr>", "value": "<value>" }, "explanation": "<sentence>", "lowConfidence": <bool> }',
  ].filter(Boolean).join("\n");
}

function buildUser(input: GenerateRuleInput): string {
  if (input.current && input.correction) {
    return JSON.stringify({ revise: input.current, correction: input.correction, original: input.text });
  }
  return input.text;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean) : []);

export async function generateRuleDraft(input: GenerateRuleInput, chat: ChatFn = defaultChat): Promise<RuleDraft | null> {
  if (!input.text?.trim() && !input.correction?.trim()) return null;
  const raw = await chat(buildSystem(input), buildUser(input));
  if (!raw) return null;

  const explanation = str(raw.explanation);
  const lowConfidence = Boolean(raw.lowConfidence);
  const known = input.knownGroups ?? [];

  if (input.kind === "persona") {
    const condition = str(raw.match);
    const v = validateCondition(condition);
    return {
      kind: "persona", ruleType: "persona", condition,
      conditionValid: v.ok, conditionError: v.ok ? undefined : v.error,
      personaName: str(raw.personaName) || "New persona",
      titles: strList(raw.titles),
      groups: matchNames(strList(raw.groups), known),
      explanation, lowConfidence,
    };
  }

  const condition = str(raw.when);
  const v = validateCondition(condition);
  const base = { kind: "rule" as const, condition, conditionValid: v.ok, conditionError: v.ok ? undefined : v.error, explanation, lowConfidence };
  const ruleType = raw.ruleType === "ou" || raw.ruleType === "attribute" ? raw.ruleType : "group";

  if (ruleType === "ou") {
    const path = str(raw.ou);
    const matched = !input.knownOus?.length || input.knownOus.some((o) => norm(o) === norm(path));
    return { ...base, ruleType: "ou", ou: { path, matched } };
  }
  if (ruleType === "attribute") {
    const a = (raw.attribute ?? {}) as Record<string, unknown>;
    return { ...base, ruleType: "attribute", attribute: { name: str(a.name), value: str(a.value) } };
  }
  return { ...base, ruleType: "group", groups: matchNames(strList(raw.groups), known) };
}

async function defaultChat(system: string, user: string): Promise<Record<string, unknown> | null> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return null;
  return azureChatJson(cfg, system, user, 700); // redaction applied inside azureChatJson
}
