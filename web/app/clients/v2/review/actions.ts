"use server";
// Runs the client-roster review: deterministic heuristics + an LLM pass that flags the fuzzy issues
// (a domain that doesn't look like it belongs to the company, odd formats, anything clearly off).
import { requireUser, AuthError } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { heuristicFindings, type ReviewFinding, type ReviewCategory, type ReviewSeverity } from "@/lib/clients/review";
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "@/lib/generator/llm";
import type { ClientListItem } from "@/lib/clients/types";

const CATEGORIES: ReviewCategory[] = ["missing-domain", "malformed-domain", "domain-name-mismatch", "email-format", "other"];
const SEVERITIES: ReviewSeverity[] = ["high", "medium", "low"];
const BATCH = 40;

const SYSTEM = `You review IT client records for data-quality problems. Each record has an index (i), a company name, a primary email domain, and an email-format pattern (how usernames/UPNs are built).
Flag ONLY records that look wrong or clearly worth a human's review, such as:
- the domain probably does NOT belong to that company (looks like a different/unrelated organization),
- the domain is missing, malformed, or is actually a tenant GUID or a URL,
- the email format is strange, empty, or inconsistent with a normal {first}/{last} scheme,
- anything else that is obviously inconsistent or suspicious.
Do NOT flag records that look fine. Be conservative — a plausible domain for the company is fine even if it isn't an exact word match.
Return JSON: {"findings":[{"i":<index>,"category":"missing-domain|malformed-domain|domain-name-mismatch|email-format|other","severity":"high|medium|low","reason":"<short, specific>"}]}`;

async function aiFindings(clients: ClientListItem[]): Promise<ReviewFinding[]> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return [];
  const out: ReviewFinding[] = [];
  for (let start = 0; start < clients.length; start += BATCH) {
    const batch = clients.slice(start, start + BATCH);
    const payload = batch.map((c, i) => ({ i, name: c.name, domain: c.primaryDomain || "(none)", emailFormat: c.usernamePattern || "(none)" }));
    const res = await azureChatJson(cfg, SYSTEM, JSON.stringify(payload), 1200);
    const findings = (res?.findings ?? []) as Array<{ i?: number; category?: string; severity?: string; reason?: string }>;
    for (const f of Array.isArray(findings) ? findings : []) {
      const c = typeof f.i === "number" ? batch[f.i] : undefined;
      if (!c || !f.reason) continue;
      out.push({
        clientId: c.id, slug: c.slug, clientName: c.name,
        category: (CATEGORIES as string[]).includes(f.category ?? "") ? (f.category as ReviewCategory) : "other",
        severity: (SEVERITIES as string[]).includes(f.severity ?? "") ? (f.severity as ReviewSeverity) : "medium",
        message: String(f.reason).slice(0, 240),
        source: "ai",
      });
    }
  }
  return out;
}

export type ReviewResult = { findings: ReviewFinding[]; clientCount: number; aiUsed: boolean };

export async function runClientReview(): Promise<ReviewResult | { error: string }> {
  try {
    await requireUser();
    const scope = await currentClientScope(db);
    const clients = await makeClientRepository(db).listClients(scope);
    const heuristic = heuristicFindings(clients);

    // Don't let the LLM re-report what a heuristic already nailed for the same client+category.
    const seen = new Set(heuristic.map((f) => `${f.clientId}:${f.category}`));
    const ai = (await aiFindings(clients)).filter((f) => !seen.has(`${f.clientId}:${f.category}`));

    return { findings: [...heuristic, ...ai], clientCount: clients.length, aiUsed: azureConfigured(azureConfigFromEnv()) };
  } catch (e) {
    return { error: e instanceof AuthError ? e.message : e instanceof Error ? e.message : "review failed" };
  }
}
