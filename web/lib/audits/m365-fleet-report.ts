// The M365 Graph permission picture for EVERY client that has Microsoft 365 — as chat-ready text.
//
// Why this exists next to m365-audit.ts rather than inside it: scanPermissions() walks the wired
// m365-admin credentials, which is the right target set for "who is missing a permission". It is the
// WRONG target set for "what is the state of the fleet", because a client with no credential at all
// never appears — and today that is 63 of the 139 clients with Microsoft 365. A report that silently
// omits the worst-off half reads as "all good over here" precisely where it isn't.
//
// So: this module takes both halves (the swept rows + every M365 client) and joins them, so a client
// can only be absent from the report by not having Microsoft 365.
//
// Pure — no DB, no network, no I/O. The caller supplies the data; these functions only shape it.
import type { PermissionRow } from "./m365-audit";
import { GRAPH_REQUIRED_CAPS, GRAPH_OPTIONAL_CAPS, suggestedRole, type SurplusRole } from "../secrets/graph-caps";

// The only role names that can ever appear in a missing list, and so the only ones a headline can
// count. m365-audit fills those lists via suggestedRole(), which returns a capability's FIRST anyOf —
// so `--role Directory.ReadWrite.All` (a legitimate alternative for the user-write capability, and
// one several tenants actually hold) can never match, and would headline "0/31 are missing it" about
// a role no client is ever reported as missing. Silently answering the wrong question with a
// confident number is worse than refusing.
export const reportableRoles = (): string[] => [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS].map(suggestedRole);

// A client that has Microsoft 365 configured.
//
// `hasCredential` is read from the database, and MUST NOT be inferred from the client's absence from
// the sweep. Those are different facts: "no m365-admin secret is wired" is a finding; "the sweep did
// not cover this client" is ignorance. Conflating them lets a partial sweep — e.g. a capture taken
// through audit-m365-graph-perms.ts's own --missing/--client filters — report a client whose
// credential is wired and working as "not configured", which is not a dropped client but an invented
// one, posted to a customer-visible room as fact.
export type M365Client = { slug: string; name: string; hasCredential: boolean };

export type FleetState =
  | "not-configured" // no m365-admin secret wired — nothing to check
  | "cred-unusable" // wired, but it cannot authenticate (GA account, bad secret) — permissions unknowable
  | "unverified" // authenticated, but Graph didn't answer completely (throttling) — NOT evidence of a gap
  | "verified"; // we read the granted roles and can speak to them

export type FleetRow = {
  client: string;
  slug: string;
  state: FleetState;
  grantedCount: number;
  missingRequired: string[];
  missingOptional: string[];
  surplus: SurplusRole[];
  detail?: string;
};

const STATE_FROM_AUDIT: Record<PermissionRow["status"], FleetState> = {
  ok: "verified",
  gaps: "verified",
  unverified: "unverified",
  "cred-bad": "cred-unusable",
  // NOT "cred-unusable": "no-cred" is returned when Delinea did not resolve the secret
  // (m365-audit.ts:89), which says nothing about the credential. scanPermissions mints ONE Delinea
  // token for the whole sweep, so a token expiring or a rate-limit part-way through turns every
  // remaining client into "no-cred" — and calling that "cannot authenticate" would send the team to
  // re-wire dozens of working credentials, and post the count to chat as fact. Unknown, not broken.
  "no-cred": "unverified",
};

// Join the swept rows onto the full M365 client list. A client with no swept row has no wired
// credential — "not configured", which is a finding, not an omission.
//
// The NAME always comes from the client list, never from the swept row: both read the same Client
// table, but sourcing it from the row would mean a client's name in the report depended on whether
// its credential happened to authenticate — and the not-configured rows have no swept row to take a
// name from at all. One source, one name, whatever the state.
export function buildFleetRows(perm: readonly PermissionRow[], m365Clients: readonly M365Client[]): FleetRow[] {
  const bySlug = new Map(perm.map((p) => [p.slug, p]));
  const rows: FleetRow[] = m365Clients.map((c) => {
    const p = bySlug.get(c.slug);
    if (!p) {
      // No swept row. What that means depends entirely on whether a credential is wired — see the
      // note on M365Client. Never nothing-to-report by default.
      return c.hasCredential
        ? { client: c.name, slug: c.slug, state: "unverified" as const, grantedCount: 0, missingRequired: [], missingOptional: [], surplus: [], detail: "a credential is wired but this sweep did not cover it — the results being reported are incomplete" }
        : { client: c.name, slug: c.slug, state: "not-configured" as const, grantedCount: 0, missingRequired: [], missingOptional: [], surplus: [] };
    }
    return {
      client: c.name,
      slug: c.slug,
      // ?? "unverified": a status this map doesn't know would otherwise be `undefined`, which matches
      // no section, so the client would be counted in the total and rendered nowhere — the silent drop
      // this module exists to prevent. An unknown status is something we cannot speak to, so say that.
      state: STATE_FROM_AUDIT[p.status] ?? "unverified",
      grantedCount: p.granted.length,
      missingRequired: p.missingRequired,
      missingOptional: p.missingOptional,
      surplus: p.surplus,
      detail: STATE_FROM_AUDIT[p.status] ? p.detail : `unrecognised audit status "${p.status}"`,
    };
  });

  // A swept row whose client is not in the list would otherwise vanish from both the body and the
  // totals. It shouldn't happen (both read the same table), but "shouldn't happen" is how a client
  // missing a REQUIRED role goes unreported. Carry it rather than drop it.
  const known = new Set(m365Clients.map((c) => c.slug));
  for (const p of perm) {
    if (known.has(p.slug)) continue;
    rows.push({
      client: p.client,
      slug: p.slug,
      state: STATE_FROM_AUDIT[p.status] ?? "unverified",
      grantedCount: p.granted.length,
      missingRequired: p.missingRequired,
      missingOptional: p.missingOptional,
      surplus: p.surplus,
      detail: p.detail,
    });
  }
  return rows.sort((a, b) => a.client.localeCompare(b.client));
}

// One client, one line. Named roles rather than counts: "missing 1 optional" is not something anyone
// can act on, and the whole point of the report is that it names the role to go and grant.
export function formatRow(r: FleetRow): string {
  if (r.state === "not-configured") return `${r.client} — not configured (no credential)`;
  if (r.state === "cred-unusable") return `${r.client} — credential unusable: ${r.detail ?? "cannot authenticate"}`;
  // Report the REASON we couldn't verify, not a guess at it. "unverified" has several producers —
  // a throttled app-role read, a Delinea resolve failure, a sweep that never covered the client — and
  // hardcoding "Graph throttled the read; re-run" told the room a permanent failure was transient.
  if (r.state === "unverified") return `${r.client} — could not verify: ${r.detail ?? "the read did not complete"}; re-run before acting`;

  const bits: string[] = [`${r.grantedCount} roles`];
  if (r.missingRequired.length) bits.push(`MISSING: ${r.missingRequired.join(", ")}`);
  if (r.missingOptional.length) bits.push(`missing: ${r.missingOptional.join(", ")}`);
  // Escalation-capable surplus is the half a security team acts on, so it is named separately from
  // the merely-unused. Both are advisory: holding a role we don't use is not a fault in our setup.
  const esc = r.surplus.filter((s) => s.escalation).map((s) => s.role);
  if (esc.length) bits.push(`OVER-PERMISSIONED: ${esc.join(", ")}`);
  const spare = r.surplus.filter((s) => !s.escalation).map((s) => s.role);
  if (spare.length) bits.push(`unused: ${spare.join(", ")}`);
  if (!r.missingRequired.length && !r.missingOptional.length && !r.surplus.length) return `${r.client} — ${r.grantedCount} roles, exactly what's needed`;
  return `${r.client} — ${bits.join(" · ")}`;
}

export type FleetSummary = {
  total: number;
  notConfigured: number;
  credUnusable: number;
  unverified: number;
  verified: number;
  missingRole: number; // verified clients missing a given role
  escalation: number; // verified clients holding an escalation-capable role
};

export function summarize(rows: readonly FleetRow[], role: string): FleetSummary {
  const n = (s: FleetState) => rows.filter((r) => r.state === s).length;
  const verified = rows.filter((r) => r.state === "verified");
  return {
    total: rows.length,
    notConfigured: n("not-configured"),
    credUnusable: n("cred-unusable"),
    unverified: n("unverified"),
    verified: verified.length,
    missingRole: verified.filter((r) => [...r.missingRequired, ...r.missingOptional].some((m) => m.toLowerCase() === role.toLowerCase())).length,
    escalation: verified.filter((r) => r.surplus.some((s) => s.escalation)).length,
  };
}

// Pack names onto as few lines as possible without any line exceeding `width`.
//
// Not cosmetic: chunkLines TRUNCATES a line that cannot fit a message, so emitting 63 client names as
// one comma-joined line would silently drop the tail — the one failure this report must not have. A
// name longer than `width` still gets its own (over-long) line and is left for chunkLines to cut;
// losing part of one name is survivable, losing whole clients is not.
export function wrapNames(names: readonly string[], width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const n of names) {
    const next = cur ? `${cur}, ${n}` : n;
    if (cur && next.length > width) {
      out.push(`${cur},`);
      cur = n;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// How wide a wrapped name line may be. Comfortably under ZOOM_MESSAGE_BUDGET so a name line always fits a
// message with its title, and short enough to stay readable in a chat pane.
const NAME_WRAP = 300;

// The section headings reportLines emits: SHOUTED WORDS, an optional "— lowercase gloss", then a
// "(count)". chunkLines uses this to avoid stranding a heading at the end of a message.
//
// Recognising them by shape is only safe because `report body headings are all recognised as
// headings` pins it: add a section whose heading doesn't match and that test fails rather than the
// heading quietly losing its no-orphan protection.
const SECTION_HEADER_RE = /^[A-Z][A-Z ]*(— [^(]*)?\(\d+\)$/;
export const isSectionHeader = (line: string): boolean => SECTION_HEADER_RE.test(line);

// The report body, grouped by state. Grouping beats one flat A–Z list because the states call for
// different actions: grant a role / fix a credential / configure one / re-run.
//
// The two credential-less sections are grouped by REASON and their clients listed as names, not as a
// line each: 39 clients sharing one 150-character explanation is 39 copies of the same sentence, and
// it buried the section that needs reading. Grouping is on the exact detail string rather than a
// pattern match, so a reworded reason regroups itself instead of silently falling out of its bucket.
export function reportLines(rows: readonly FleetRow[], role: string): string[] {
  const s = summarize(rows, role);
  const out: string[] = [
    `${s.total} clients have Microsoft 365.`,
    `${s.verified} credentials work · ${s.credUnusable} wired but cannot authenticate · ${s.notConfigured} not configured${s.unverified ? ` · ${s.unverified} unverified` : ""}`,
    `${s.missingRole}/${s.verified} working credentials are missing ${role}.`,
    `${s.escalation} hold a role that can escalate their own authority.`,
  ];

  const perClient = (title: string, list: readonly FleetRow[]) => {
    if (!list.length) return;
    out.push("", `${title} (${list.length})`);
    for (const r of list) out.push(formatRow(r));
  };
  const byReason = (title: string, list: readonly FleetRow[], fallback: string) => {
    if (!list.length) return;
    out.push("", `${title} (${list.length})`);
    const groups = new Map<string, string[]>();
    for (const r of list) {
      const k = r.detail ?? fallback;
      groups.set(k, [...(groups.get(k) ?? []), r.client]);
    }
    for (const [reason, names] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`• ${reason} — ${names.length}:`);
      out.push(...wrapNames(names, NAME_WRAP).map((l) => `    ${l}`));
    }
  };

  perClient("WORKING CREDENTIAL", rows.filter((r) => r.state === "verified"));
  perClient("COULD NOT VERIFY", rows.filter((r) => r.state === "unverified"));
  byReason("CREDENTIAL WIRED BUT UNUSABLE", rows.filter((r) => r.state === "cred-unusable"), "cannot authenticate");

  const bare = rows.filter((r) => r.state === "not-configured");
  if (bare.length) {
    out.push("", `NOT CONFIGURED — no credential wired (${bare.length})`);
    out.push(...wrapNames(bare.map((r) => r.client), NAME_WRAP));
  }
  return out;
}

// Zoom's cap on a chat message is 4000 characters — their own answer said 4096 first and was later
// CORRECTED to 4000, and a report split against 4096 verifiably arrived with its tail silently cut
// off mid-list (2026-07-17 fleet report). Zoom does not document whether it counts characters or
// bytes, and this report is full of multibyte punctuation ("—", "·"), so the budget is measured in
// UTF-8 BYTES with margin: a message of ≤3800 bytes fits the cap under either reading (chars ≤ bytes).
// The budget is per MESSAGE and the title rides in the same payload (sender.messageText prepends
// it), so the title's cost comes out of each chunk's allowance.
export const ZOOM_MESSAGE_BUDGET = 3800;
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

// Split lines into chunks whose rendered "title\nline\nline…" stays under `limit`.
//
// `titleFor(i, total)` is a callback rather than a string because the title carries the "(2/5)"
// counter — which depends on the total, which is not known until the split is done. That is circular:
// the title's width comes out of each chunk's budget, so a wider title makes more chunks, and more
// chunks make a wider counter ("9/9" → "9/10").
//
// Two passes do NOT settle this. Splitting for "Report" (6 chars) can yield 9 chunks; re-splitting for
// "Report 9/9" (10) can then yield 10, whose real titles are "Report 4/10" (11) — one wider than the
// budget they were split against, so every full chunk lands 1 char over and Zoom rejects it. So:
// iterate to a fixed point, where the width we split against is at least the width the resulting
// count actually needs. Each round strictly widens, and the width only grows with the counter's digit
// count, so it settles in a couple of rounds.
export function chunkLines(lines: readonly string[], titleFor: (i: number, total: number) => string, limit: number = ZOOM_MESSAGE_BUDGET): { title: string; detail: string }[] {
  // Hard-cut a line to fit `maxBytes` UTF-8 bytes including a trailing ellipsis. Binary search on the
  // slice length: a cut can land inside a surrogate pair, which encodes as a 3-byte replacement — ugly
  // in one pathological name, but never over budget.
  const cutToBytes = (s: string, maxBytes: number): string => {
    const room = Math.max(0, maxBytes - utf8Len("…"));
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (utf8Len(s.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
    }
    return `${s.slice(0, lo)}…`;
  };
  const split = (titleWidth: number): string[][] => {
    const chunks: string[][] = [];
    let cur: string[] = [];
    let size = 0;
    const fitted = lines.map((raw) => {
      // A single line longer than the whole budget can never fit; hard-cut it rather than emit a
      // message the transport will reject outright.
      const room = limit - titleWidth - 1;
      return utf8Len(raw) > room ? cutToBytes(raw, room) : raw;
    });
    for (const [i, line] of fitted.entries()) {
      const cost = utf8Len(line) + 1; // +1 for the newline joining it to what precedes
      // A section heading stranded as the last line of a message leaves the next message a wall of
      // names with nothing saying what they are — and chat does not guarantee the two stay adjacent.
      // So a heading only starts here if its first row fits here too.
      const next = fitted[i + 1];
      const need = isSectionHeader(line) && next !== undefined ? cost + utf8Len(next) + 1 : cost;
      if (cur.length && size + need > limit - titleWidth) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(line);
      size += cost;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  };

  // The widest title any of `total` chunks will carry. Measured over every index, not just the first
  // and last, so a titleFor that is not monotonic in `i` cannot slip a wider title past the budget.
  const maxTitleWidth = (total: number): number => {
    let w = 0;
    for (let i = 0; i < Math.max(1, total); i++) w = Math.max(w, utf8Len(titleFor(i, total)));
    return w;
  };

  let width = maxTitleWidth(1);
  let chunks = split(width);
  let settled = false;
  for (let round = 0; round < 8; round++) {
    const need = maxTitleWidth(chunks.length);
    if (need <= width) { settled = true; break; }
    width = need;
    chunks = split(width);
  }
  // Belt and braces: if it somehow hasn't settled, split against the width for the worst case there
  // is — one chunk per line, which no split can exceed. Guaranteed to fit, at the cost of a slightly
  // narrower body. Being a character over the limit is silent non-delivery; being under is invisible.
  if (!settled && maxTitleWidth(chunks.length) > width) chunks = split(maxTitleWidth(Math.max(1, lines.length)));

  return chunks.map((c, i) => ({ title: titleFor(i, chunks.length), detail: c.join("\n") }));
}
