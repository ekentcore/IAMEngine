// LLM last-resort resolver: when the deterministic intake mapping leaves a field unknown, try Azure
// OpenAI for a best guess BEFORE holding the case as "Needs Information". A confident result fills the
// field (marked AI-derived so an operator can confirm); a low-confidence/empty result leaves it
// unknown (the case still holds). No-op when Azure isn't configured — the deterministic flow stands.
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "../generator/llm";

export type AiResolution = {
  payload: Record<string, unknown>;
  resolved: string[]; // field keys the LLM filled
  notes: Record<string, string>; // per-field "AI determined X (confidence) — verify"
};

const CONFIDENCE_FLOOR = 0.7;
// This runs on the synchronous case-import HTTP path; cap the LLM round-trip well under any gateway
// timeout (azureChatJson's own AbortSignal is 60s). A timeout returns null → field stays unknown →
// the case holds for info, which is the safe outcome.
const AI_TIMEOUT_MS = 8000;
function withTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_TIMEOUT_MS))]);
}

export async function resolveUnknownsWithAI(payload: Record<string, unknown>): Promise<AiResolution> {
  const unknown = Array.isArray(payload.unknownFields) ? (payload.unknownFields as { field: string }[]) : [];
  if (unknown.length === 0) return { payload, resolved: [], notes: {} };
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return { payload, resolved: [], notes: {} };

  const out = { ...payload };
  const resolved: string[] = [];
  const notes: Record<string, string> = {};
  const has = (f: string) => unknown.some((u) => u.field === f);

  // usageLocation — infer the ISO-3166 alpha-2 country from whatever location signals we have.
  if (has("usageLocation")) {
    const res = await withTimeout(azureChatJson(
      cfg,
      'Map a person\'s work location to the ISO-3166 alpha-2 country code for Microsoft 365 UsageLocation. Return STRICT JSON: {"code":"<2-letter code or empty>","confidence":<0..1>}.',
      `Office location: "${String(out.officeLocation ?? "")}". Timezone: "${String(out.timezone ?? "")}". Department: "${String(out.department ?? "")}". Which country (ISO alpha-2) is this person based in?`,
      120
    ));
    const code = typeof res?.code === "string" ? res.code.trim().toUpperCase() : "";
    const confidence = typeof res?.confidence === "number" ? res.confidence : 0;
    if (/^[A-Z]{2}$/.test(code) && confidence >= CONFIDENCE_FLOOR) {
      out.usageLocation = code;
      out.usageLocationDerived = true;
      out.usageLocationSource = "ai";
      resolved.push("usageLocation");
      notes.usageLocation = `AI determined ${code} (confidence ${Math.round(confidence * 100)}%) — verify`;
    }
  }

  out.unknownFields = unknown.filter((u) => !resolved.includes(u.field));
  if (resolved.length) out.aiResolved = { ...(out.aiResolved as Record<string, string> | undefined), ...notes };
  return { payload: out, resolved, notes };
}
