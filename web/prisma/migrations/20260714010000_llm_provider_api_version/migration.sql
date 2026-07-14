-- Optional ?api-version= for openai-compatible providers. Azure's classic
-- /openai/deployments/{id} path requires it; /openai/v1 defaults to "v1". Null for
-- OpenAI / OpenRouter / Hugging Face, so existing rows keep working untouched.
ALTER TABLE "LlmProvider" ADD COLUMN "apiVersion" TEXT;
