// Server side of the LLM provider registry (LlmProvider table): masked listing for the Settings
// UI, default-provider resolution for the fix lane, and the 1-token connectivity test. The API
// key never leaves the server — every read path goes through toMasked().
import type { LlmProvider, PrismaClient } from "@prisma/client";
import { maskKey, type LlmAdapter } from "./provider-presets";

export type MaskedLlmProvider = {
  id: string;
  name: string;
  adapter: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  isDefault: boolean;
};

export function toMasked(p: LlmProvider): MaskedLlmProvider {
  return { id: p.id, name: p.name, adapter: p.adapter, baseUrl: p.baseUrl, model: p.model, apiKeyMasked: maskKey(p.apiKey), isDefault: p.isDefault };
}

export async function listProvidersMasked(db: PrismaClient): Promise<MaskedLlmProvider[]> {
  const rows = await db.llmProvider.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toMasked);
}

// The provider the fix lane uses: the default, or the only one there is.
export async function getDefaultProvider(db: PrismaClient): Promise<LlmProvider | null> {
  return (await db.llmProvider.findFirst({ where: { isDefault: true } })) ?? (await db.llmProvider.findFirst());
}

export type ProviderInput = { name: string; adapter: LlmAdapter; baseUrl: string; model: string; apiKey: string; isDefault: boolean };

// Field validation shared by create + update. Returns an error message or null.
export function providerInputProblem(p: { name?: unknown; adapter?: unknown; baseUrl?: unknown; model?: unknown }): string | null {
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) return "name is required (max 80 chars)";
  if (p.adapter !== "anthropic" && p.adapter !== "openai-compatible") return "adapter must be anthropic or openai-compatible";
  if (typeof p.baseUrl !== "string" || !/^https?:\/\/\S+$/i.test(p.baseUrl.trim())) return "baseUrl must be an http(s) URL";
  if (typeof p.model !== "string" || !p.model.trim() || p.model.length > 200) return "model is required";
  return null;
}

// Make `id` the sole default (or clear the flag). Wrapped in a transaction so two concurrent
// saves can't leave zero or two defaults.
export async function setDefaultFlag(db: PrismaClient, id: string, isDefault: boolean): Promise<void> {
  await db.$transaction(async (tx) => {
    if (isDefault) await tx.llmProvider.updateMany({ where: { NOT: { id } }, data: { isDefault: false } });
    await tx.llmProvider.update({ where: { id }, data: { isDefault } });
  });
}

// 1-token connectivity test — proves endpoint + key + model resolve, nothing more.
export async function testProvider(p: Pick<LlmProvider, "name" | "adapter" | "baseUrl" | "model" | "apiKey">): Promise<{ ok: boolean; detail: string }> {
  const base = p.baseUrl.replace(/\/+$/, "");
  const req: { url: string; headers: Record<string, string>; body: unknown } =
    p.adapter === "anthropic"
      ? {
          url: `${base}/v1/messages`,
          headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
          body: { model: p.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        }
      : {
          url: `${base}/chat/completions`,
          // Bearer covers OpenAI/OpenRouter/HF; api-key covers Azure's OpenAI-compatible endpoint.
          headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}`, "api-key": p.apiKey },
          body: { model: p.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        };
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { ok: true, detail: `${p.name}: ok (${p.model})` };
    const text = (await res.text().catch(() => "")).slice(0, 400);
    return { ok: false, detail: `${res.status} ${res.statusText}${text ? ` — ${text}` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "request failed" };
  }
}
