// Minimal Azure OpenAI chat client for the generator's enrichment pass. JSON mode only.
// Reads AZURE_OPENAI_* from process.env (loaded from env.env by the CLI).
import { redact } from "../automation/redact";

export type AzureConfig = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
};

export function azureConfigFromEnv(): AzureConfig {
  return {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? "",
    apiKey: process.env.AZURE_OPENAI_KEY ?? "",
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o-mini",
    apiVersion: process.env.AZURE_OPENAI_VERSION ?? "2025-01-01-preview",
  };
}

export function azureConfigured(c: AzureConfig): boolean {
  return Boolean(c.endpoint && c.apiKey && c.deployment);
}

// Call chat completions in JSON mode; returns the parsed object, or null on any failure.
export async function azureChatJson(
  c: AzureConfig,
  system: string,
  user: string
): Promise<Record<string, unknown> | null> {
  const url = `${c.endpoint}/openai/deployments/${c.deployment}/chat/completions?api-version=${c.apiVersion}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": c.apiKey },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          // redact secrets/PII from user-supplied content before it leaves the boundary
          { role: "user", content: redact(user) },
        ],
        temperature: 0,
        max_tokens: 600,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
