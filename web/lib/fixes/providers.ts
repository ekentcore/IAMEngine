// Server side of the LLM provider registry (LlmProvider table): masked listing for the Settings
// UI, default-provider resolution for the fix lane, and the 1-token connectivity test. The API
// key never leaves the server — every read path goes through toMasked().
import type { LlmProvider, PrismaClient } from "@prisma/client";
import { apiVersionProblem, chatCompletionsUrl, maskKey, type LlmAdapter } from "./provider-presets";
import { chatWithAdaptation } from "./chat-request";

export type MaskedLlmProvider = {
  id: string;
  name: string;
  adapter: string;
  baseUrl: string;
  model: string;
  apiVersion: string | null;
  apiKeyMasked: string;
  isDefault: boolean;
};

export function toMasked(p: LlmProvider): MaskedLlmProvider {
  return { id: p.id, name: p.name, adapter: p.adapter, baseUrl: p.baseUrl, model: p.model, apiVersion: p.apiVersion, apiKeyMasked: maskKey(p.apiKey), isDefault: p.isDefault };
}

export async function listProvidersMasked(db: PrismaClient): Promise<MaskedLlmProvider[]> {
  const rows = await db.llmProvider.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toMasked);
}

// The provider the fix lane uses: the default, or the only one there is.
export async function getDefaultProvider(db: PrismaClient): Promise<LlmProvider | null> {
  return (await db.llmProvider.findFirst({ where: { isDefault: true } })) ?? (await db.llmProvider.findFirst());
}

export type ProviderInput = { name: string; adapter: LlmAdapter; baseUrl: string; model: string; apiVersion: string | null; apiKey: string; isDefault: boolean };

// Field validation shared by create + update. Returns an error message or null.
export function providerInputProblem(p: { name?: unknown; adapter?: unknown; baseUrl?: unknown; model?: unknown; apiVersion?: unknown }): string | null {
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) return "name is required (max 80 chars)";
  if (p.adapter !== "anthropic" && p.adapter !== "openai-compatible") return "adapter must be anthropic or openai-compatible";
  if (typeof p.baseUrl !== "string" || !/^https?:\/\/\S+$/i.test(p.baseUrl.trim())) return "baseUrl must be an http(s) URL";
  if (typeof p.model !== "string" || !p.model.trim() || p.model.length > 200) return "model is required";
  return apiVersionProblem(p.apiVersion);
}

// Normalize the api-version input: blank → null (meaning "don't send the query param at all").
export function normalizeApiVersion(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The origin (scheme://host:port) a provider's calls are sent to — the security-relevant part of a
// baseUrl. null when it can't be parsed.
function originOf(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string") return null;
  try {
    return new URL(baseUrl.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
}

// Would this edit send the stored key to a DIFFERENT host? That — not any URL edit — is what must
// be proven by re-entering the key, since exfiltration requires a host the attacker controls. A
// path-only change (e.g. swapping an Azure deployment) keeps the key on the same host.
// FAILS CLOSED: if either URL is unparseable we cannot prove the host is unchanged, so we say yes.
export function keyDestinationChanged(before: string, after: unknown): boolean {
  const a = originOf(before);
  const b = originOf(after);
  if (a === null || b === null) return true;
  return a !== b;
}

// Make `id` the sole default (or clear the flag). Wrapped in a transaction so two concurrent
// saves can't leave zero or two defaults.
export async function setDefaultFlag(db: PrismaClient, id: string, isDefault: boolean): Promise<void> {
  await db.$transaction(async (tx) => {
    if (isDefault) await tx.llmProvider.updateMany({ where: { NOT: { id } }, data: { isDefault: false } });
    await tx.llmProvider.update({ where: { id }, data: { isDefault } });
  });
}

export const TEST_PROMPT_MAX = 2000;
const ANSWER_MAX_TOKENS = 400; // enough for a real answer; still a cheap probe
const ANSWER_CHARS_MAX = 4000;
const EMPTY_REPLY = "(the model returned an empty reply)";

// Pull the assistant's reply out of either wire format.
export function answerFromResponse(adapter: string, json: unknown): string {
  const j = json as {
    content?: Array<{ type?: string; text?: string }>; // anthropic
    choices?: Array<{ message?: { content?: string } }>; // openai-compatible
  };
  const text =
    adapter === "anthropic"
      ? (j?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
      : (j?.choices?.[0]?.message?.content ?? "");
  return (text ?? "").trim().slice(0, ANSWER_CHARS_MAX);
}

// Connectivity test. With no question it's a cheap ping — proves endpoint + key + model resolve,
// nothing more. Given a question, it asks that instead and returns the model's answer, so an
// operator can confirm the provider is actually wired to the model they think it is.
// The key never leaves the server; only the question travels from the browser.
//
// For openai-compatible providers the body ADAPTS to the model (see chat-request.ts): gpt-5 rejects
// max_tokens, and gpt-5.6-luna additionally rejects temperature. We guess, and if the model objects,
// we do what it says and retry — so a new model works without a code change.
export async function testProvider(
  p: Pick<LlmProvider, "name" | "adapter" | "baseUrl" | "model" | "apiVersion" | "apiKey">,
  question?: string
): Promise<{ ok: boolean; detail: string; answer?: string; asked?: string }> {
  const asked = typeof question === "string" ? question.trim().slice(0, TEST_PROMPT_MAX) : "";
  const prompt = asked || "ping";
  const base = p.baseUrl.replace(/\/+$/, "");

  try {
    if (p.adapter === "anthropic") {
      // Anthropic's contract is stable: max_tokens, always required.
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: p.model, max_tokens: asked ? ANSWER_MAX_TOKENS : 1, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(asked ? 60_000 : 20_000),
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 400);
        return { ok: false, detail: `${res.status} ${res.statusText}${text ? ` — ${text}` : ""}` };
      }
      if (!asked) return { ok: true, detail: `${p.name}: ok (${p.model})` };
      const answer = answerFromResponse(p.adapter, await res.json().catch(() => null));
      return { ok: true, detail: `${p.name}: ok (${p.model})`, answer: answer || EMPTY_REPLY, asked };
    }

    // ?api-version= is appended when the provider pins one — required by Azure's classic
    // deployments path, optional on its /openai/v1 surface.
    const url = chatCompletionsUrl(p.baseUrl, p.apiVersion);
    const attempt = await chatWithAdaptation(
      url,
      // Bearer covers OpenAI/OpenRouter/HF; api-key covers Azure's OpenAI-compatible endpoint.
      { "content-type": "application/json", authorization: `Bearer ${p.apiKey}`, "api-key": p.apiKey },
      {
        model: p.model,
        messages: [{ role: "user", content: prompt }],
        // A reasoning model needs room to think even to say "pong" — a 1-token cap is a hard 400,
        // not a truncated reply. tokenBudget() raises the floor for those models automatically.
        maxTokens: asked ? ANSWER_MAX_TOKENS : 1,
      },
      { timeoutMs: asked ? 90_000 : 30_000 }
    );

    if (!attempt.ok) {
      const err = (attempt.json as { error?: { message?: string } })?.error?.message;
      return { ok: false, detail: `${attempt.status}${err ? ` — ${err}` : attempt.errorText ? ` — ${attempt.errorText}` : ""}` };
    }
    if (!asked) return { ok: true, detail: `${p.name}: ok (${p.model})` };
    const answer = answerFromResponse(p.adapter, attempt.json);
    return { ok: true, detail: `${p.name}: ok (${p.model})`, answer: answer || EMPTY_REPLY, asked };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "request failed" };
  }
}
