// Find a client's onboarding/offboarding KB articles from its ServiceNow account, so an import can
// build the client out without anyone hunting for KB numbers.
//
// There is no account -> article reference field in ServiceNow. The link is the DOMAIN: a
// customer_account carries sys_domain (e.g. "TOP/Digital Currency Group, Inc.") and that client's
// kb_knowledge rows carry the same one. (It is the same key the static KB corpus in data/*.jsonl
// was grouped on — its `domain_raw`.)
//
// The domain is necessary but not sufficient: it also holds the client's uploaded PDFs, .docx and
// spreadsheets, several of which have "Onboarding" in the title ("Pacific Lake Partners -
// Onboarding_Docs.docx"), and article_type is "text" for those too — so the type can't discriminate
// and we score the titles instead.
import type { SnConfig } from "./types";
import { snGet, assertConfig } from "./http";

export type KbCandidate = {
  number: string;
  title: string;
  action: "onboard" | "offboard";
  score: number;
  // The title reads as an actual runbook ("... Guide"). A pick WITHOUT this is a fallback — e.g.
  // Century Equity has no onboarding guide at all, only an "Offboard User Request" doc — so the
  // import flags it for review rather than presenting a guessed runbook as authoritative.
  confident: boolean;
  latest: boolean;
  published: boolean;
  updatedAt: string;
};

export type KbDiscovery = {
  onboard: KbCandidate | null;
  offboard: KbCandidate | null;
  candidates: KbCandidate[]; // every scored candidate, best-first — so the UI can say a pick was made among several
};

type KbRow = {
  number?: { display_value?: string; value?: string };
  short_description?: { display_value?: string; value?: string };
  workflow_state?: { value?: string };
  latest?: { value?: string };
  kb_knowledge_base?: { display_value?: string };
  sys_updated_on?: { value?: string };
};

type Fetcher = typeof fetch;

const FIELDS = "number,short_description,workflow_state,latest,kb_knowledge_base,sys_updated_on";
const LIMIT = "100";

// The shared KB base every client's docs land in. A guide in the client's OWN base is the
// curated one, so it outranks a same-titled article in the shared pile.
const SHARED_BASE = "co-managed it";

// Titles that are really uploaded files. These are attachments, not runbooks — adopting one as a
// client's runbook would fill it with a document's prose (or nothing at all).
const ATTACHMENT_EXT = /\.(docx?|pdf|xlsx?|pptx?|msg|csv|txt|png|jpe?g|zip)\s*$/i;

const truthy = (v?: string) => v === "true" || v === "1";

// Which lifecycle action a title claims. "Onboarding"/"Onboard" and "Offboarding"/"Offboard" —
// note "offboard" CONTAINS "onboard" only if you're careless with substrings, hence the word-ish
// boundary. A title naming both (or neither) is ambiguous and claims nothing: a combined
// on+offboarding doc can't be saved as one action's runbook without corrupting the other.
function actionOf(title: string): "onboard" | "offboard" | null {
  const t = title.toLowerCase();

  // Combined docs are written in shorthand far more often than in full: "On/Off Boarding Guide",
  // "On & Off Boarding", "On and Offboarding". The word-boundary tests below DON'T see the "on" in
  // those (it isn't followed by "board"), so the doc reads as offboard-only — and the whole thing,
  // account-creation steps and all, would be saved as the client's OFFBOARD runbook. Catch the
  // shorthand first and claim neither action.
  if (/\bon\s*[/&+]\s*off[\s-]?board/.test(t) || /\bon\s+and\s+off[\s-]?board/.test(t) || /\bon-\/?off[\s-]?board/.test(t)) {
    return null;
  }

  const off = /\boff[\s-]?board(ing)?\b/.test(t);
  const on = /(?<!f)\bon[\s-]?board(ing)?\b/.test(t);
  if (on && off) return null;
  if (on) return "onboard";
  if (off) return "offboard";
  return null;
}

export function scoreKbCandidates(rows: KbRow[]): KbDiscovery {
  const candidates: KbCandidate[] = [];
  // kb_knowledge keeps every REVISION as its own row under the same number, so one guide can appear
  // many times. Keep the best row per number (the sort below settles which) — otherwise a heavily
  // revised article crowds the candidate list with copies of itself.
  const bestByNumber = new Map<string, KbCandidate>();

  for (const r of rows) {
    const title = (r.short_description?.display_value ?? r.short_description?.value ?? "").trim();
    const number = (r.number?.display_value ?? r.number?.value ?? "").trim();
    if (!title || !number) continue;
    if (ATTACHMENT_EXT.test(title)) continue;

    const action = actionOf(title);
    if (!action) continue;

    const latest = truthy(r.latest?.value);
    const published = (r.workflow_state?.value ?? "").toLowerCase() === "published";
    const ownBase = (r.kb_knowledge_base?.display_value ?? "").trim().toLowerCase() !== SHARED_BASE;
    const updatedAt = r.sys_updated_on?.value ?? "";

    // "Guide" is the strongest signal that this is the runbook rather than, say, a "User
    // Offboarding Form" or a quick note that happens to mention offboarding.
    const isGuide = /\bguide\b/i.test(title);
    let score = 0;
    if (isGuide) score += 8;
    if (ownBase) score += 4;
    if (latest) score += 2;
    if (published) score += 1;

    const c: KbCandidate = { number, title, action, score, confident: isGuide, latest, published, updatedAt };
    const seen = bestByNumber.get(number);
    if (!seen || c.score > seen.score || (c.score === seen.score && c.updatedAt > seen.updatedAt)) {
      bestByNumber.set(number, c);
    }
  }
  candidates.push(...bestByNumber.values());

  // Best-first: score, then recency as the tie-break (SN's datetime format sorts lexicographically).
  candidates.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));

  return {
    onboard: candidates.find((c) => c.action === "onboard") ?? null,
    offboard: candidates.find((c) => c.action === "offboard") ?? null,
    candidates,
  };
}

const EMPTY: KbDiscovery = { onboard: null, offboard: null, candidates: [] };

async function query(config: SnConfig, sysparm_query: string, fetcher: Fetcher): Promise<KbRow[]> {
  return snGet<KbRow[]>(
    config,
    "/api/now/table/kb_knowledge",
    { sysparm_query, sysparm_fields: FIELDS, sysparm_display_value: "all", sysparm_limit: LIMIT },
    fetcher
  );
}

// Every onboarding/offboarding KB in a client's ServiceNow domain, scored, with the best pick per
// action. Returns empty (never throws for a missing domain) when the account has no domain.
export async function findClientKbs(
  config: SnConfig,
  domainSysId: string,
  fetcher: Fetcher = fetch
): Promise<KbDiscovery> {
  // A sys_id is 32 hex chars. Validate before interpolating: ServiceNow parses `^` in sysparm_query
  // as an operator, so an unvalidated value could inject query conditions (same guard as
  // fetchAccountContactEmails).
  if (!/^[0-9a-f]{32}$/i.test(domainSysId)) return EMPTY;
  assertConfig(config);

  // Ask ServiceNow for the boarding articles rather than the whole domain. A big client's domain
  // holds hundreds of rows (every article, times every revision) — enough to push the guide past any
  // row limit we set. "board" catches Onboarding / Offboarding / Off-Boarding / New Onboard alike;
  // the handful of Dashboard/Keyboard false hits are dropped by the title scoring anyway.
  const scope = `sys_domain=${domainSysId}^short_descriptionLIKEboard`;
  const base = `${scope}^ORDERBYDESCsys_updated_on`;
  const published = await query(config, `${scope}^workflow_state=published^ORDERBYDESCsys_updated_on`, fetcher);
  const first = scoreKbCandidates(published);

  // Settle only when BOTH picks are real guides. A published non-guide — Century Equity's "Offboard
  // User Request" form — is a pick, but a poor one, and stopping here would hide an actual guide that
  // happens to be a draft/retired revision (for some clients that is the only one there is: the same
  // case the profile generator's best_per_action recovers).
  if (first.onboard?.confident && first.offboard?.confident) return first;

  const all = await query(config, base, fetcher);
  const second = scoreKbCandidates(all);

  // Prefer a guide over a non-guide, whatever its state; between two of a kind, the published pass
  // wins (a published guide always beats a draft one).
  const better = (a: KbCandidate | null, b: KbCandidate | null) => {
    if (!a) return b;
    if (!b) return a;
    if (a.confident !== b.confident) return a.confident ? a : b;
    return a;
  };

  return {
    onboard: better(first.onboard, second.onboard),
    offboard: better(first.offboard, second.offboard),
    candidates: second.candidates.length ? second.candidates : first.candidates,
  };
}
