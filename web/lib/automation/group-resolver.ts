// Resolve which permission groups a user needs from a parsed group-mapping sheet, using the
// LLM only for the DECISION (which rows apply to this department/title/location). The cell
// reading is deterministic (xls-groups); a guardrail keeps the model to group names that
// actually appear in the sheet. Redaction happens inside azureChatJson (the boundary).
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "../generator/llm";
import { sheetCellValues, type GroupSheet } from "./xls-groups";

export type UserAttrs = { department?: string; jobTitle?: string; location?: string };
export type GroupResolution = {
  groups: string[]; // trusted: the value appears in the sheet
  unverified: string[]; // model-suggested but NOT in the sheet — surfaced, not trusted
  reasoning: string;
  lowConfidence: boolean;
};

type ChatFn = (system: string, user: string) => Promise<Record<string, unknown> | null>;

const SYSTEM = `You map a user to permission groups using a group-mapping table from an IT runbook.
Input JSON: { "table": { "headers": [...], "rows": [...] }, "user": { "department", "jobTitle", "location" } }.
Return STRICT JSON only: { "groups": ["<exact group name copied from the table>"], "reasoning": "<one short sentence>", "lowConfidence": <boolean> }.
Rules:
- First find the row(s) whose key column (e.g. Department/Role/Location) matches the user.
- Then output the GROUP values from that row: security groups, distribution lists (DLs), Microsoft 365 groups, SharePoint groups — splitting cells that list several (comma/semicolon/newline separated) into individual names.
- Do NOT output the value you matched on (e.g. the department name itself) and do NOT output person names (e.g. a Manager column).
- Only output names that literally appear in the table. If the table or user info is too sparse to decide confidently, return your best guess and set lowConfidence to true.`;

export async function resolveGroups(
  sheet: GroupSheet,
  user: UserAttrs,
  chat: ChatFn = defaultChat
): Promise<GroupResolution | null> {
  const payload = JSON.stringify({ table: { headers: sheet.headers, rows: sheet.rows }, user });
  const raw = await chat(SYSTEM, payload);
  if (!raw) return null;

  const suggested = Array.isArray(raw.groups) ? raw.groups.map(String) : [];
  const haystack = sheetCellValues(sheet).join("\n").toLowerCase(); // guardrail corpus
  const groups: string[] = [];
  const unverified: string[] = [];
  for (const g of suggested) (haystack.includes(g.toLowerCase()) ? groups : unverified).push(g);

  return { groups, unverified, reasoning: String(raw.reasoning ?? ""), lowConfidence: Boolean(raw.lowConfidence) };
}

async function defaultChat(system: string, user: string): Promise<Record<string, unknown> | null> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return null;
  return azureChatJson(cfg, system, user); // redaction applied inside azureChatJson
}
