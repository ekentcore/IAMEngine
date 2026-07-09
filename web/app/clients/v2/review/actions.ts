"use server";
// Runs the client-roster review: deterministic heuristics + an LLM pass that flags the fuzzy issues
// (a domain that doesn't look like it belongs to the company, odd formats, anything clearly off).
import { requireUser, AuthError } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { heuristicFindings, type ReviewFinding, type ReviewCategory, type ReviewSeverity } from "@/lib/clients/review";
import { probeDomains, type DomainProbe } from "@/lib/clients/domain-probe";
import { azureChatJson, azureConfigFromEnv, azureConfigured } from "@/lib/generator/llm";
import type { ClientListItem } from "@/lib/clients/types";

const CATEGORIES: ReviewCategory[] = ["missing-domain", "malformed-domain", "domain-name-mismatch", "domain-unreachable", "email-format", "other"];
const SEVERITIES: ReviewSeverity[] = ["high", "medium", "low"];
const BATCH = 30;

const SYSTEM = `You review IT client records for data-quality problems. Each record has an index (i), a company name, a primary email domain, an email-format pattern, and — when we could load it — what the domain's WEBSITE actually returned (the final URL after redirects, the page <title>, and a description).
Use the live page evidence: does the site that loads actually belong to that company? A title/description naming a DIFFERENT company, a parked/for-sale page, or a redirect to an unrelated domain all mean the domain on file is suspect.
Flag ONLY records worth a human's review:
- the domain (or the site it loads) probably does NOT belong to that company,
- the domain is missing, malformed, or is a tenant GUID / URL,
- the email format is strange, empty, or not a normal {first}/{last} scheme,
- anything else clearly inconsistent.
Do NOT flag records that look fine. Be conservative — a plausible domain whose site clearly is the company is fine even if the words don't match exactly. If a site simply failed to load, that's already reported elsewhere — only flag it if the name itself looks wrong.
Return JSON: {"findings":[{"i":<index>,"category":"missing-domain|malformed-domain|domain-name-mismatch|domain-unreachable|email-format|other","severity":"high|medium|low","reason":"<short, specific; cite the page title/redirect when relevant>"}]}`;

async function aiFindings(clients: ClientListItem[], probes: Map<string, DomainProbe>): Promise<ReviewFinding[]> {
  const cfg = azureConfigFromEnv();
  if (!azureConfigured(cfg)) return [];
  const out: ReviewFinding[] = [];
  for (let start = 0; start < clients.length; start += BATCH) {
    const batch = clients.slice(start, start + BATCH);
    const payload = batch.map((c, i) => {
      const p = probes.get((c.primaryDomain ?? "").trim());
      return {
        i, name: c.name, domain: c.primaryDomain || "(none)", emailFormat: c.usernamePattern || "(none)",
        site: p && (p.loaded || p.title) ? { loadedFinalUrl: p.finalUrl, title: p.title, description: p.description, redirectedAway: p.redirectedAway } : (p ? { failed: p.error ?? "did not load" } : undefined),
      };
    });
    const res = await azureChatJson(cfg, SYSTEM, JSON.stringify(payload), 1500);
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

// Direct findings from actually loading the site (no LLM): a domain that won't load, or one that
// redirects to an unrelated registrable domain.
function probeFindings(clients: ClientListItem[], probes: Map<string, DomainProbe>): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const c of clients) {
    const d = (c.primaryDomain ?? "").trim();
    const p = d ? probes.get(d) : undefined;
    if (!p || p.error === "not a public domain") continue;
    if (!p.loaded) {
      out.push({ clientId: c.id, slug: c.slug, clientName: c.name, category: "domain-unreachable", severity: "medium", message: `Domain "${d}" didn't load (${p.error ?? "no response"}) — confirm it's still the company's site`, source: "heuristic" });
    } else if (p.redirectedAway && p.finalDomain) {
      out.push({ clientId: c.id, slug: c.slug, clientName: c.name, category: "domain-name-mismatch", severity: "low", message: `"${d}" redirects to ${p.finalDomain}${p.title ? ` ("${p.title}")` : ""} — verify the right domain is on file`, source: "heuristic" });
    }
  }
  return out;
}

export type ReviewResult = { findings: ReviewFinding[]; clientCount: number; aiUsed: boolean; domainsChecked: number };

export async function runClientReview(): Promise<ReviewResult | { error: string }> {
  try {
    await requireUser();
    const scope = await currentClientScope(db);
    const clients = await makeClientRepository(db).listClients(scope);
    const heuristic = heuristicFindings(clients);

    // Load every well-formed domain to see what its live site returns (bounded concurrency).
    const domains = clients.map((c) => (c.primaryDomain ?? "").trim()).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d));
    const probes = await probeDomains(domains);
    const probe = probeFindings(clients, probes);

    // Don't let later passes re-report what an earlier one already nailed for the same client+category.
    const seen = new Set([...heuristic, ...probe].map((f) => `${f.clientId}:${f.category}`));
    const ai = (await aiFindings(clients, probes)).filter((f) => !seen.has(`${f.clientId}:${f.category}`));

    return { findings: [...heuristic, ...probe, ...ai], clientCount: clients.length, aiUsed: azureConfigured(azureConfigFromEnv()), domainsChecked: probes.size };
  } catch (e) {
    return { error: e instanceof AuthError ? e.message : e instanceof Error ? e.message : "review failed" };
  }
}
