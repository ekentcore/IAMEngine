// LLM provider presets for the fix lane's Settings UI. Client-safe (no Prisma, no secrets): just
// the well-known endpoints so adding a provider is one click + paste-the-key. The registry itself
// is extensible — any OpenAI-compatible endpoint works with a custom base URL.

export type LlmAdapter = "anthropic" | "openai-compatible";

export type LlmProviderPreset = {
  key: string;
  name: string;
  adapter: LlmAdapter;
  baseUrl: string;
  model: string; // a sensible default; editable
  apiVersion?: string; // openai-compatible only; appended as ?api-version=. Azure needs it.
  keyHint: string; // where to mint the API key
};

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  { key: "claude", name: "Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", keyHint: "console.anthropic.com → API keys" },
  { key: "openai", name: "OpenAI", adapter: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", keyHint: "platform.openai.com → API keys" },
  { key: "openrouter", name: "OpenRouter", adapter: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", keyHint: "openrouter.ai → Keys" },
  // Two Azure shapes. The v1 surface defaults to api-version=v1, so the field is optional there
  // ("preview" opts into preview features). The classic deployments path REQUIRES api-version,
  // and carries the deployment name in the URL rather than the model field.
  { key: "azure", name: "Azure AI", adapter: "openai-compatible", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", model: "gpt-4o", keyHint: "Azure portal → your OpenAI resource → Keys" },
  { key: "azure-deployment", name: "Azure AI (deployment)", adapter: "openai-compatible", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT", model: "gpt-4o", apiVersion: "2024-10-21", keyHint: "Azure portal → your OpenAI resource → Keys" },
  { key: "huggingface", name: "Hugging Face", adapter: "openai-compatible", baseUrl: "https://router.huggingface.co/v1", model: "meta-llama/Llama-3.3-70B-Instruct", keyHint: "huggingface.co → Settings → Access tokens" },
];

export const ADAPTERS: { value: LlmAdapter; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Messages API)" },
  { value: "openai-compatible", label: "OpenAI-compatible (chat/completions)" },
];

// Mask an API key for display: only the last 4 characters survive.
export function maskKey(key: string): string {
  return typeof key === "string" && key.length > 4 ? `…${key.slice(-4)}` : "••••";
}

// The chat/completions URL for an openai-compatible provider, with ?api-version= appended when
// the provider pins one. Pure + client-safe so the Settings form can show the exact URL it will
// call. scripts/llm-fix.mjs mirrors this (see openAiAdapter.url) — change both together.
export function chatCompletionsUrl(baseUrl: string, apiVersion?: string | null): string {
  const base = baseUrl.replace(/\/+$/, "");
  const version = (apiVersion ?? "").trim();
  return version ? `${base}/chat/completions?api-version=${encodeURIComponent(version)}` : `${base}/chat/completions`;
}

// api-version is a short token: "2024-10-21", "preview", "v1". Empty means "don't send it".
export function apiVersionProblem(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return "apiVersion must be a string";
  const t = v.trim();
  if (!t) return null;
  if (t.length > 40) return "apiVersion is too long (max 40 chars)";
  if (!/^[A-Za-z0-9._-]+$/.test(t)) return "apiVersion may only contain letters, digits, dots, dashes and underscores";
  return null;
}
