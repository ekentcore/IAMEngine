// Data-quality review for the client roster. Heuristics here are pure + deterministic (cheap, no
// network) — they catch the obvious problems. The fuzzy "this domain doesn't look like it belongs to
// this company" / "anything else weird" judgments are layered on by an LLM pass (see the /clients/v2
// review server action), which reuses these findings and adds its own.
import type { ClientListItem } from "./types";

export type ReviewSeverity = "high" | "medium" | "low";
export type ReviewCategory = "missing-domain" | "malformed-domain" | "domain-name-mismatch" | "email-format" | "other";

export type ReviewFinding = {
  clientId: string;
  slug: string;
  clientName: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  message: string;
  source: "heuristic" | "ai";
};

// Corporate suffixes / filler that carry no identity — ignored when matching a name to its domain.
const NAME_STOPWORDS = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "company", "co", "ltd", "limited", "llp", "lp",
  "plc", "group", "the", "and", "of", "services", "service", "solutions", "solution", "partners",
  "partnership", "associates", "consulting", "technologies", "technology", "systems", "holdings",
  "enterprises", "enterprise", "management", "global", "international", "usa", "us",
]);

function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Domain segments minus the TLD, e.g. "newcoinc.com" -> ["newcoinc"], "mail.acme.co.uk" -> ["mail","acme","co"].
function domainTokens(domain: string): string[] {
  const segs = domain.toLowerCase().split(".").filter(Boolean);
  return segs.length > 1 ? segs.slice(0, -1) : segs;
}

function domainLooksMalformed(d: string): boolean {
  if (/\s/.test(d)) return true;                       // spaces
  if (/^https?:\/\//i.test(d)) return true;            // a URL, not a domain
  if (d.includes("/") || d.includes("@")) return true; // path / email address
  if (!d.includes(".")) return true;                   // no TLD at all
  if (/^[0-9a-f-]{36}$/i.test(d)) return true;         // a tenant GUID pasted as a domain
  return !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d);      // not a clean hostname
}

// True when the domain shares NO recognizable token with the company name — the "is this really
// their domain?" flag (e.g. "JAMS Software LLC" -> newcoinc.com). Conservative: any 3+char overlap,
// or the name's initialism matching a domain segment, counts as a match (so we only flag clear misses).
function domainNameMismatch(name: string, domain: string): boolean {
  const nTok = nameTokens(name).filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
  const dTok = domainTokens(domain).filter((t) => t.length >= 3);
  if (nTok.length === 0 || dTok.length === 0) return false; // nothing meaningful to compare — don't flag
  const initials = nameTokens(name).filter((t) => !NAME_STOPWORDS.has(t)).map((t) => t[0]).join("");
  for (const d of dTok) {
    if (initials.length >= 2 && (d === initials || d.includes(initials))) return false;
    for (const n of nTok) {
      if (n === d || n.includes(d) || d.includes(n)) return false;
    }
  }
  return true;
}

function emailFormatIssue(pattern: string): string | null {
  const pat = pattern.trim();
  if (!pat) return "No email / username format is set";
  if (!/\{[a-z_]+\}/i.test(pat)) return `Email format has no {first}/{last} placeholders: "${pat}"`;
  return null;
}

// Deterministic findings over the roster. The AI pass adds the subtle ones on top of these.
export function heuristicFindings(clients: ClientListItem[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const add = (c: ClientListItem, category: ReviewCategory, severity: ReviewSeverity, message: string) =>
    out.push({ clientId: c.id, slug: c.slug, clientName: c.name, category, severity, message, source: "heuristic" });

  for (const c of clients) {
    const domain = (c.primaryDomain ?? "").trim();
    if (!domain) {
      add(c, "missing-domain", "high", "No primary domain set — onboarding can't resolve the tenant / email address");
    } else if (domainLooksMalformed(domain)) {
      add(c, "malformed-domain", "high", `Primary domain looks malformed: "${domain}"`);
    } else if (domainNameMismatch(c.name, domain)) {
      add(c, "domain-name-mismatch", "medium", `Domain "${domain}" doesn't obviously match the client name — verify it's the right tenant/domain`);
    }

    const ef = emailFormatIssue(c.usernamePattern ?? "");
    if (ef) add(c, "email-format", "medium", ef);
  }
  return out;
}
