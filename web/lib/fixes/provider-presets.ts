// LLM provider presets for the fix lane's Settings UI. Client-safe (no Prisma, no secrets): just
// the well-known endpoints so adding a provider is one click + paste-the-key. The registry itself
// is extensible — any OpenAI-compatible endpoint works with a custom base URL.

export type LlmAdapter = "anthropic" | "openai-compatible";

// How the Settings form asks for a provider's endpoint.
//   "generic" — one raw base URL + a model name (OpenAI, OpenRouter, Hugging Face, Claude).
//   "azure"   — Azure names the same thing in three parts, so the form asks for them separately
//               (resource endpoint + deployment + api-version) and derives the base URL. Making the
//               operator hand-assemble .../openai/deployments/<name> is exactly how you end up with
//               a provider that 404s.
// Adding a new shape means: a case here, a builder/parser pair below, and a branch in the form.
export type ProviderShape = "generic" | "azure";

export type LlmProviderPreset = {
  key: string;
  name: string;
  adapter: LlmAdapter;
  shape: ProviderShape;
  // For "generic": the literal base URL. For "azure": the RESOURCE ENDPOINT (no path).
  baseUrl: string;
  // For "generic": the model name. For "azure": the DEPLOYMENT name — in Azure the deployment is
  // what selects the model, so this is the field you change to point at a different model.
  model: string;
  apiVersion?: string; // openai-compatible only; appended as ?api-version=. Azure requires it.
  keyHint: string; // where to mint the API key
};

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  { key: "claude", name: "Claude", adapter: "anthropic", shape: "generic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", keyHint: "console.anthropic.com → API keys" },
  { key: "openai", name: "OpenAI", adapter: "openai-compatible", shape: "generic", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", keyHint: "platform.openai.com → API keys" },
  { key: "openrouter", name: "OpenRouter", adapter: "openai-compatible", shape: "generic", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", keyHint: "openrouter.ai → Keys" },
  // The classic deployments path works on every Azure OpenAI resource and REQUIRES api-version.
  // (The newer /openai/v1 surface defaults the version; register that with the Custom preset.)
  { key: "azure", name: "Azure AI", adapter: "openai-compatible", shape: "azure", baseUrl: "https://YOUR-RESOURCE.openai.azure.com", model: "gpt-4o-mini", apiVersion: "2025-01-01-preview", keyHint: "Azure portal → your OpenAI resource → Keys and Endpoint" },
  { key: "huggingface", name: "Hugging Face", adapter: "openai-compatible", shape: "generic", baseUrl: "https://router.huggingface.co/v1", model: "meta-llama/Llama-3.3-70B-Instruct", keyHint: "huggingface.co → Settings → Access tokens" },
  { key: "custom", name: "Custom", adapter: "openai-compatible", shape: "generic", baseUrl: "", model: "", keyHint: "any OpenAI-compatible endpoint — paste its base URL" },
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

// ── Azure ────────────────────────────────────────────────────────────────────
// Azure's chat endpoint is <resource endpoint>/openai/deployments/<deployment>, and the DEPLOYMENT
// (not the request body's model) is what picks the model. The form collects the two parts and these
// two functions convert between them and the single baseUrl we store.

const AZURE_DEPLOYMENT_PATH = /^(https?:\/\/[^/?#]+)\/openai\/deployments\/([^/?#]+)\/*$/i;

// endpoint + deployment → the baseUrl we store. "" when either part is missing.
export function azureBaseUrl(endpoint: string, deployment: string): string {
  const host = (endpoint ?? "").trim().replace(/\/+$/, "");
  const dep = (deployment ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!host || !dep) return "";
  return `${host}/openai/deployments/${encodeURIComponent(dep)}`;
}

// The inverse: recognise a stored Azure baseUrl so editing it re-opens the Azure form rather than
// the raw-URL one. Returns null for anything that isn't the deployments shape.
export function parseAzureBaseUrl(baseUrl: string): { endpoint: string; deployment: string } | null {
  const m = AZURE_DEPLOYMENT_PATH.exec((baseUrl ?? "").trim());
  if (!m) return null;
  let deployment = m[2];
  try {
    deployment = decodeURIComponent(deployment);
  } catch {
    /* a stray % isn't valid encoding — keep the raw segment */
  }
  return { endpoint: m[1], deployment };
}

export function azureEndpointProblem(endpoint: unknown): string | null {
  if (typeof endpoint !== "string" || !endpoint.trim()) return "the Azure resource endpoint is required";
  const t = endpoint.trim();
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(t)) return "the endpoint must be just the resource URL, e.g. https://my-resource.openai.azure.com";
  return null;
}

export function azureDeploymentProblem(deployment: unknown): string | null {
  if (typeof deployment !== "string" || !deployment.trim()) return "the deployment name is required";
  const t = deployment.trim();
  if (t.length > 200) return "the deployment name is too long";
  if (/[/?#\s]/.test(t)) return "the deployment name can't contain spaces or / ? #";
  return null;
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
