// The "Update with AI" call: feed the current document + the change-log entries shipped since it was
// last updated to the configured LLM provider, and get back a revised document + a note on what
// changed. Reuses the provider registry's call chain (lib/fixes/*), branching on adapter exactly
// like testProvider(). Produces a DRAFT only — a human reviews the diff before it publishes.
import type { LlmProvider } from "@prisma/client";
import { chatCompletionsUrl } from "@/lib/fixes/provider-presets";
import { chatWithAdaptation } from "@/lib/fixes/chat-request";
import { answerFromResponse } from "@/lib/fixes/providers";
import type { ChangelogEntry } from "@/lib/changelog/entries";
import { DOC_BEGIN, DOC_END, NOTE_PREFIX, changelogForPrompt, isSuspiciousShrink, parseModelUpdate, type ParsedUpdate } from "./versioning";

// Documents run large and the model must REPRODUCE the whole thing, not summarize it — too small a
// cap truncates a big doc mid-body and looks like "the AI deleted half the document". But the cap
// can't exceed the model's own output ceiling, and those differ sharply: OpenAI gpt-4o-class chat
// models top out at 16384 completion tokens (32000 would 400, and chatWithAdaptation can't rescue an
// oversized budget), while modern Claude models allow far more. So it's adapter-specific: keep the
// chat path at the proven-safe 16000 and give Anthropic real headroom for the full body + note.
// (A ~40 KB markdown doc is ~13k tokens; 16000 already fits it, and the rewritten prompt + the
// server-side shrink guard are what actually stop the model from dropping content.)
const ANTHROPIC_MAX_TOKENS = 32000;
const CHAT_MAX_TOKENS = 16000;

// One text-in/text-out call to either adapter. Mirrors testProvider()'s branch so a new model works
// without a code change here.
async function callModel(p: LlmProvider, system: string, user: string): Promise<string> {
  const base = p.baseUrl.replace(/\/+$/, "");
  if (p.adapter === "anthropic") {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: p.model, max_tokens: ANTHROPIC_MAX_TOKENS, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return answerFromResponse(p.adapter, await res.json().catch(() => null));
  }
  const url = chatCompletionsUrl(p.baseUrl, p.apiVersion);
  const attempt = await chatWithAdaptation(
    url,
    { "content-type": "application/json", authorization: `Bearer ${p.apiKey}`, "api-key": p.apiKey },
    { model: p.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: CHAT_MAX_TOKENS },
    { timeoutMs: 120_000 }
  );
  if (!attempt.ok) {
    const err = (attempt.json as { error?: { message?: string } })?.error?.message;
    throw new Error(`${attempt.status}${err ? ` — ${err}` : attempt.errorText ? ` — ${attempt.errorText}` : ""}`);
  }
  return answerFromResponse(p.adapter, attempt.json);
}

function systemPrompt(): string {
  return [
    "You are a meticulous technical editor maintaining Coretelligent's IAM Engine reference documents.",
    "You are given the current document (Markdown) and the product change-log entries that shipped SINCE this document was last revised.",
    "Your job: produce the SAME document with only the small edits the change log requires — and nothing else.",
    "",
    "THE MOST IMPORTANT RULE — reproduce, do not summarize:",
    "- Output the ENTIRE document from its first line to its last. Reproduce every heading, paragraph,",
    "  table row, list item, and code block VERBATIM unless a change-log entry specifically requires changing it.",
    "- This is a surgical edit of a long document, NOT a rewrite, summary, or condensation. The updated",
    "  document must be essentially the same length as the current one. Never shorten, trim, merge, or drop",
    "  sections to be concise. If you find yourself omitting content because it seems repetitive or lengthy, STOP —",
    "  copy it through unchanged. Dropping content is a failure even if the result reads well.",
    "- Do NOT truncate. If the document is long, keep going until you have emitted all of it, then the end sentinel.",
    "",
    "Editing rules:",
    "- Only change wording where a change-log entry makes the current text inaccurate, incomplete, or newly relevant. If an entry doesn't affect this document, ignore it.",
    "- Never invent capabilities, permissions, or facts not present in the current document or the change log.",
    "- Keep it Markdown. Keep existing tables as Markdown tables. Do not add a version/changelog table — the application manages versioning outside the document body.",
    "- If nothing in the change log affects this document, return the current document EXACTLY as-is and say so in the change note.",
    "",
    "Answer in EXACTLY this format and nothing else:",
    `${NOTE_PREFIX} <one short paragraph: what you changed and why, or 'No changes — nothing in the change log affects this document.'>`,
    DOC_BEGIN,
    "<the full updated document in Markdown>",
    DOC_END,
  ].join("\n");
}

function userPrompt(title: string, currentMarkdown: string, entries: ChangelogEntry[]): string {
  return [
    `DOCUMENT TITLE: ${title}`,
    "",
    "=== CURRENT DOCUMENT (Markdown) ===",
    currentMarkdown,
    "",
    "=== CHANGE LOG SINCE LAST REVISION (newest first) ===",
    entries.length ? changelogForPrompt(entries) : "(no new change-log entries)",
  ].join("\n");
}

export type DocUpdateResult = ParsedUpdate & { raw: string; shrunk: boolean };

// Run the update. Returns the parsed markdown + change note. `shrunk` flags a suspiciously short
// result (the model dropped content) so the reviewer is warned before publishing.
export async function runDocumentUpdate(
  p: LlmProvider,
  opts: { title: string; currentMarkdown: string; entries: ChangelogEntry[] }
): Promise<DocUpdateResult> {
  const raw = await callModel(p, systemPrompt(), userPrompt(opts.title, opts.currentMarkdown, opts.entries));
  const parsed = parseModelUpdate(raw);
  if (!parsed.markdown.trim()) throw new Error("the model returned an empty document");
  const shrunk = isSuspiciousShrink(opts.currentMarkdown, parsed.markdown);
  return { ...parsed, raw, shrunk };
}
