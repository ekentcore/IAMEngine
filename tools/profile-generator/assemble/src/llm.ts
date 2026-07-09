// Minimal Azure OpenAI chat client for the assemble stage's v2.1 enrichment. JSON mode only.
// Reads AZUREAI_* (env.env convention), falling back to AZURE_OPENAI_*. No deps beyond global fetch.

export interface AzureConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
}

export function azureConfigFromEnv(): AzureConfig {
  const e = process.env;
  return {
    endpoint: e.AZUREAI_BASE ?? e.AZURE_OPENAI_ENDPOINT ?? "",
    apiKey: e.AZUREAI_API ?? e.AZURE_OPENAI_KEY ?? "",
    deployment: e.AZUREAI_DEPLOYMENT ?? e.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o-mini",
    apiVersion: e.AZUREAI_VERSION ?? e.AZURE_OPENAI_VERSION ?? "2025-01-01-preview",
  };
}

export function azureConfigured(c: AzureConfig): boolean {
  return Boolean(c.endpoint && c.apiKey && c.deployment);
}

// Light redaction before runbook text leaves the boundary: emails, long digit runs, GUIDs.
function redact(s: string): string {
  return s
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<guid>")
    .replace(/\b\d{7,}\b/g, "<num>");
}

export async function azureChatJson(
  c: AzureConfig,
  system: string,
  user: string,
  maxTokens = 1500
): Promise<Record<string, unknown> | null> {
  const url = `${c.endpoint}/openai/deployments/${c.deployment}/chat/completions?api-version=${c.apiVersion}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": c.apiKey },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: redact(user) },
        ],
        temperature: 0,
        max_tokens: maxTokens,
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
