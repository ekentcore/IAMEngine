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
  keyHint: string; // where to mint the API key
};

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  { key: "claude", name: "Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", keyHint: "console.anthropic.com → API keys" },
  { key: "openai", name: "OpenAI", adapter: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", keyHint: "platform.openai.com → API keys" },
  { key: "openrouter", name: "OpenRouter", adapter: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", keyHint: "openrouter.ai → Keys" },
  { key: "azure", name: "Azure AI", adapter: "openai-compatible", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1", model: "gpt-4o", keyHint: "Azure portal → your OpenAI resource → Keys" },
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
