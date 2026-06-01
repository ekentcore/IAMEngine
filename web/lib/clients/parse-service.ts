// "Parse instructions" for the systems editor: detect systems + backbone from pasted
// runbook text. Heuristic by default; optional Azure OpenAI pass for higher fidelity.
import { parseInstructions, stripHtml } from "../generator/parse";
import { CATALOG } from "../generator/system-map";
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "../generator/llm";

export type ParseInstructionsResult = {
  systems: string[]; // known catalog keys
  backbone: "entra" | "google" | "ad-synced" | "ad-standalone";
  backboneConfident: boolean;
  unmodeled: string[]; // detected labels not in the catalog
  usedAI: boolean;
};

const KNOWN = new Set(Object.keys(CATALOG));
const VALID_BACKBONE = new Set(["entra", "google", "ad-synced", "ad-standalone"]);

const AI_SYSTEM = `You analyze a Coretelligent IT onboarding/offboarding runbook. Return STRICT JSON.
Identify which of these system keys the runbook touches (only from this list):
${[...KNOWN].join(", ")}.
Also determine the identity backbone: "ad-synced" (on-prem AD synced to Entra via AD Connect),
"ad-standalone" (on-prem AD + separate unsynced M365), "google" (Google Workspace primary),
or "entra" (cloud-only M365). Prefer "entra" if unsure.
JSON shape: {"systems":["key",...],"backbone":"entra|google|ad-synced|ad-standalone","unmodeled":["label not in the list",...]}`;

export async function parseInstructionsText(text: string, useAI: boolean): Promise<ParseInstructionsResult> {
  const heuristic = parseInstructions(text);

  if (!useAI) {
    return { ...heuristic, usedAI: false };
  }

  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return { ...heuristic, usedAI: false };

  const raw = await azureChatJson(cfg, AI_SYSTEM, stripHtml(text, 8000) || text.slice(0, 8000));
  if (!raw) return { ...heuristic, usedAI: false };

  // Merge AI systems with heuristic (union), keep only known keys.
  const aiSystems = Array.isArray(raw.systems) ? raw.systems.map(String) : [];
  const merged: string[] = [...heuristic.systems];
  for (const k of aiSystems) if (KNOWN.has(k) && !merged.includes(k)) merged.push(k);

  const aiBackbone = String(raw.backbone ?? "");
  const backbone = VALID_BACKBONE.has(aiBackbone) ? (aiBackbone as ParseInstructionsResult["backbone"]) : heuristic.backbone;

  const unmodeled = Array.isArray(raw.unmodeled)
    ? [...new Set([...heuristic.unmodeled, ...raw.unmodeled.map(String)])]
    : heuristic.unmodeled;

  return { systems: merged, backbone, backboneConfident: true, unmodeled, usedAI: true };
}
