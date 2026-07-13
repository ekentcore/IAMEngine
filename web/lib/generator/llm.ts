// Minimal Azure OpenAI chat client for the generator's enrichment pass. JSON mode only.
// Reads AZURE_OPENAI_* from process.env (loaded from env.env by the CLI).
import { maskEmailsReversible, redact } from "../automation/redact";

export type AzureConfig = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
};

// Reads the AZUREAI_* vars (the env.env convention) first, falling back to the older
// AZURE_OPENAI_* names so existing setups keep working.
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

// Call chat completions in JSON mode; returns the parsed object, or null on any failure.
export async function azureChatJson(
  c: AzureConfig,
  system: string,
  user: string,
  maxTokens = 600
): Promise<Record<string, unknown> | null> {
  const url = `${c.endpoint}/openai/deployments/${c.deployment}/chat/completions?api-version=${c.apiVersion}`;
  // Emails are masked REVERSIBLY: unique placeholders go to Azure, and the real addresses are
  // restored in the response — extractors that echo the text back (runbook steps) keep group/DL
  // addresses intact instead of a lossy [user]@domain. redact() still scrubs everything else.
  const { masked, restore } = maskEmailsReversible(user);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": c.apiKey },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          // redact secrets/PII from user-supplied content before it leaves the boundary
          { role: "user", content: redact(masked) },
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
    return JSON.parse(restore(content)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
