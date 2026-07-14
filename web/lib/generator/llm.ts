// Minimal Azure OpenAI chat client for the generator's enrichment pass. JSON mode only.
// Reads AZURE_OPENAI_* from process.env (loaded from env.env by the CLI).
import { maskEmailsReversible, redact } from "../automation/redact";
import { chatWithAdaptation } from "../fixes/chat-request";

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
    // temperature: 0 and max_tokens are BOTH rejected by some models (gpt-5.6-luna refuses both;
    // gpt-5.4 refuses max_tokens only). chatWithAdaptation asks, reads the complaint, and retries
    // with what the model will accept — so pointing this at a gpt-5 deployment just works.
    const attempt = await chatWithAdaptation(
      url,
      { "Content-Type": "application/json", "api-key": c.apiKey },
      {
        model: c.deployment,
        messages: [
          { role: "system", content: system },
          // redact secrets/PII from user-supplied content before it leaves the boundary
          { role: "user", content: redact(masked) },
        ],
        maxTokens,
        temperature: 0, // dropped automatically for models that only allow the default
        extra: { response_format: { type: "json_object" } },
      },
      { timeoutMs: 90_000 }
    );
    if (!attempt.ok) return null;
    const data = attempt.json as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(restore(content)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
