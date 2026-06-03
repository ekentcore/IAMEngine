// Derive a client's EMAIL domain (for UPN/mailbox derivation) from the real email addresses of
// its ServiceNow contacts — ground truth, vs the company `website` field which is often a
// different domain (e.g. website market.science, mail marketscience.co). Pure: no I/O.

// Integration / HR / notification senders that appear in customer_contact but are never the org's
// own mail domain. Denylisted so they can't win the vote even when frequent.
const DEFAULT_DENYLIST = new Set(["rippling.com", "bamboohr.com", "workday.com", "gusto.com", "adp.com"]);

// Extract a normalized domain from a single address, or null if it isn't a well-formed address.
export function emailDomainOf(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return null;
  const parts = e.split("@");
  if (parts.length !== 2) return null; // no @, or more than one
  const [local, domain] = parts;
  if (!local || !domain) return null; // "@x.com" or "x@"
  const d = domain.replace(/\.+$/, ""); // trailing dot
  return d.includes(".") ? d : null; // must look like a domain
}

export type DomainPick = {
  domain: string | null; // the chosen domain, or null when we abstain (low confidence)
  share: number; // top domain's fraction of counted contacts (0 when none)
  counted: number; // valid, non-denylisted contacts considered
};

export type DominantOpts = {
  minContacts?: number; // need at least this many counted contacts to decide (default 3)
  minShare?: number; // the top domain must hold at least this fraction (default 0.6)
  denylist?: Iterable<string>; // integration domains to exclude before counting
};

// Pick the modal email domain when it's frequent enough to trust; otherwise abstain (null) so the
// caller falls back to a curated value or the website domain rather than guessing wrong.
export function dominantEmailDomain(emails: (string | null | undefined)[], opts: DominantOpts = {}): DomainPick {
  const minContacts = opts.minContacts ?? 3;
  const minShare = opts.minShare ?? 0.6;
  const denylist = opts.denylist ? new Set([...opts.denylist].map((d) => d.toLowerCase())) : DEFAULT_DENYLIST;

  const counts = new Map<string, number>();
  let counted = 0;
  for (const raw of emails) {
    const d = emailDomainOf(raw);
    if (!d || denylist.has(d)) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
    counted++;
  }

  if (counted === 0) return { domain: null, share: 0, counted: 0 };

  let topDomain: string | null = null;
  let topCount = 0;
  for (const [d, n] of counts) {
    if (n > topCount) {
      topCount = n;
      topDomain = d;
    }
  }
  const share = topCount / counted;
  const confident = counted >= minContacts && share >= minShare;
  return { domain: confident ? topDomain : null, share, counted };
}
