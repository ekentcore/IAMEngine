import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFleetRows, formatRow, reportLines, summarize, chunkLines, wrapNames, isSectionHeader, reportableRoles, ZOOM_MAX_CHARS, type FleetRow, type M365Client } from "./m365-fleet-report";
import type { PermissionRow } from "./m365-audit";
import { messageText } from "../notifications/sender";

const PP = "User-PasswordProfile.ReadWrite.All";

function perm(over: Partial<PermissionRow>): PermissionRow {
  return { clientId: "c1", client: "Client One", slug: "core1", status: "ok", granted: [], missingRequired: [], missingOptional: [], surplus: [], ...over };
}
function row(over: Partial<FleetRow>): FleetRow {
  return { client: "Client One", slug: "core1", state: "verified", grantedCount: 5, missingRequired: [], missingOptional: [], surplus: [], ...over };
}

// The whole reason this module exists: a client with no credential never reaches scanPermissions, so
// joining on the swept rows alone would drop 63 of 139 clients — the worst-off ones.
test("a client with Microsoft 365 but NO wired credential is reported as not configured, not omitted", () => {
  const rows = buildFleetRows([perm({ slug: "wired", client: "Wired Co" })], [
    { slug: "wired", name: "Wired Co", hasCredential: true },
    { slug: "bare", name: "Bare Co", hasCredential: false },
  ]);
  assert.equal(rows.length, 2, "every M365 client must appear");
  assert.equal(rows.find((r) => r.slug === "bare")!.state, "not-configured");
  assert.match(formatRow(rows.find((r) => r.slug === "bare")!), /not configured/);
});

test("a client with neither Microsoft 365 nor a swept row is not in the report at all", () => {
  assert.deepEqual(buildFleetRows([], []), []);
});

test("audit statuses map to the state the reader must act on", () => {
  const clients = [{ slug: "a", name: "A", hasCredential: true }, { slug: "b", name: "B", hasCredential: true }, { slug: "c", name: "C", hasCredential: true }, { slug: "d", name: "D", hasCredential: true }];
  const rows = buildFleetRows(
    [
      perm({ slug: "a", status: "ok" }),
      perm({ slug: "b", status: "gaps" }),
      perm({ slug: "c", status: "unverified" }),
      perm({ slug: "d", status: "cred-bad" }),
    ],
    clients
  );
  const state = (s: string) => rows.find((r) => r.slug === s)!.state;
  // ok and gaps are BOTH verified reads — the difference is what they found, not whether we know.
  assert.equal(state("a"), "verified");
  assert.equal(state("b"), "verified");
  assert.equal(state("c"), "unverified");
  assert.equal(state("d"), "cred-unusable");
});

// A throttled read once reported every permission as missing (PR #90). An unconfirmed gap must never
// be counted as a gap, or the report sends people to grant roles they already have.
test("an unverified client is never counted as missing the role", () => {
  const rows = buildFleetRows([perm({ slug: "t", status: "unverified", missingOptional: [PP] })], [{ slug: "t", name: "Throttled", hasCredential: true }]);
  const s = summarize(rows, PP);
  assert.equal(s.missingRole, 0, "a throttled read is not evidence of a gap");
  assert.equal(s.verified, 0);
  assert.match(formatRow(rows[0]), /could not verify/i);
});

test("a cred-unusable client is never counted as missing the role — we learned nothing about it", () => {
  const rows = buildFleetRows([perm({ slug: "x", status: "cred-bad", detail: "Global Admin account" })], [{ slug: "x", name: "Ex", hasCredential: true }]);
  assert.equal(summarize(rows, PP).missingRole, 0);
  assert.match(formatRow(rows[0]), /credential unusable: Global Admin account/);
});

test("the row names the missing and over-permissioned roles, not just counts them", () => {
  const line = formatRow(row({
    missingOptional: [PP],
    surplus: [
      { role: "RoleManagement.ReadWrite.Directory", escalation: true, why: "can make itself GA" },
      { role: "Sites.Read.All", escalation: false, why: "never called" },
    ],
  }));
  assert.match(line, new RegExp(PP.replace(/\./g, "\\.")), "must name the role to grant");
  assert.match(line, /OVER-PERMISSIONED: RoleManagement\.ReadWrite\.Directory/);
  assert.match(line, /unused: Sites\.Read\.All/);
});

test("a required gap is shouted and an optional one is not — they are different jobs", () => {
  assert.match(formatRow(row({ missingRequired: ["User.ReadWrite.All"] })), /MISSING: User\.ReadWrite\.All/);
  const opt = formatRow(row({ missingOptional: [PP] }));
  assert.ok(!/MISSING:/.test(opt), "an optional gap must not read like a required one");
  assert.match(opt, /missing: /);
});

test("a clean credential says so plainly rather than listing nothing", () => {
  assert.match(formatRow(row({ grantedCount: 7 })), /7 roles, exactly what's needed/);
});

test("summary counts each state once and only counts escalation among verified clients", () => {
  const rows = buildFleetRows(
    [
      perm({ slug: "a", status: "ok", missingOptional: [PP], surplus: [{ role: "Application.ReadWrite.All", escalation: true, why: "w" }] }),
      perm({ slug: "b", status: "ok", granted: ["x"] }),
      perm({ slug: "c", status: "cred-bad" }),
    ],
    [{ slug: "a", name: "A", hasCredential: true }, { slug: "b", name: "B", hasCredential: true }, { slug: "c", name: "C", hasCredential: true }, { slug: "d", name: "D", hasCredential: false }]
  );
  const s = summarize(rows, PP);
  assert.deepEqual(
    { total: s.total, verified: s.verified, credUnusable: s.credUnusable, notConfigured: s.notConfigured, missingRole: s.missingRole, escalation: s.escalation },
    { total: 4, verified: 2, credUnusable: 1, notConfigured: 1, missingRole: 1, escalation: 1 }
  );
});

// ── "not configured" is a fact about the DB, never an inference from the sweep ───────────────────
// The failure this guards: capture a sweep through audit-m365-graph-perms.ts's own --missing filter,
// feed it to --from, and every client NOT missing that role has no swept row. Inferring
// "not configured" from that absence invents a state — and --send posts it to a customer-visible room
// as fact about clients whose credentials are wired and working.
test("a client whose credential is wired but which the sweep did not cover is UNVERIFIED, not 'not configured'", () => {
  const rows = buildFleetRows([], [{ slug: "skipped", name: "Skipped Co", hasCredential: true }]);
  assert.equal(rows[0].state, "unverified", "a partial sweep must never fabricate 'not configured'");
  assert.equal(summarize(rows, PP).notConfigured, 0);
  assert.match(formatRow(rows[0]), /did not cover it|incomplete/i);
});

test("a Delinea resolve failure is unverified, not a broken credential", () => {
  // no-cred = Delinea did not answer (m365-audit.ts:89). The sweep shares ONE Delinea token, so a
  // mid-sweep expiry turns the rest of the fleet into no-cred; calling that "cannot authenticate"
  // would send the team to re-wire working credentials and post the count to chat as fact.
  const rows = buildFleetRows([perm({ slug: "d", status: "no-cred", detail: "could not resolve the secret" })], [{ slug: "d", name: "Delinea Blip", hasCredential: true }]);
  assert.equal(rows[0].state, "unverified");
  assert.equal(summarize(rows, PP).credUnusable, 0, "an unresolved secret is not a confirmed credential fault");
});

test("an unrecognised audit status is surfaced as unverified, never dropped into no section", () => {
  const rows = buildFleetRows([perm({ slug: "w", status: "wat" as PermissionRow["status"] })], [{ slug: "w", name: "Weird Co", hasCredential: true }]);
  assert.equal(rows[0].state, "unverified");
  const text = reportLines(rows, PP).join("\n");
  assert.ok(text.includes("Weird Co"), "counted in the total but rendered nowhere is the silent drop this module exists to prevent");
});

test("a swept row for a client missing from the M365 list is carried, not dropped", () => {
  const rows = buildFleetRows([perm({ slug: "ghost", client: "Ghost Co", status: "gaps", missingRequired: ["User.ReadWrite.All"] })], []);
  assert.equal(rows.length, 1, "a client missing a REQUIRED role must never vanish");
  assert.match(formatRow(rows[0]), /MISSING: User\.ReadWrite\.All/);
});

test("the unverified row reports WHY, rather than guessing at throttling", () => {
  const rows = buildFleetRows([perm({ slug: "u", status: "unverified", detail: "Graph returned 403 for the app-role read" })], [{ slug: "u", name: "U Co", hasCredential: true }]);
  assert.match(formatRow(rows[0]), /Graph returned 403/, "a permanent failure must not be reported as a transient one");
});

test("only roles that can actually be reported as missing are offered to --role", () => {
  const roles = reportableRoles();
  assert.ok(roles.includes(PP), "the role this report headlines must be reportable");
  // suggestedRole is anyOf[0], so an alternative can never appear in a missing list — counting it
  // would headline a confident, false 0.
  assert.ok(!roles.includes("Directory.ReadWrite.All"), "an alternative role would always score 0");
});

// ── Chunking ────────────────────────────────────────────────────────────────
// Zoom rejects a message over 4096 chars and the send path has no guard, so an over-long chunk is a
// message that silently never arrives.

test("every chunk, rendered exactly as the sender will render it, fits Zoom's limit", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `Client Number ${i} — 12 roles · missing: ${PP} · OVER-PERMISSIONED: RoleManagement.ReadWrite.Directory`);
  const chunks = chunkLines(lines, (i, n) => `M365 permissions (${i + 1}/${n})`);
  assert.ok(chunks.length > 1, "400 rich lines must need more than one message");
  for (const c of chunks) {
    // messageText is what actually goes on the wire — measure THAT, not the detail alone.
    assert.ok(messageText({ event: "announcement", title: c.title, detail: c.detail }).length <= ZOOM_MAX_CHARS, `chunk over the limit: ${c.title}`);
  }
});

// Regression: the title's width comes out of each chunk's budget, and the title carries the chunk
// COUNT — so sizing the budget for a 9-chunk title ("Report 9/9") and then producing 10 chunks makes
// every real title one char wider than what was budgeted for. Every full message then lands at 4097
// and Zoom rejects it: the report silently never arrives. Two passes cannot settle a circular
// constraint; these are the sizes where the count crosses a digit boundary.
test("a report whose chunk count grows a digit still fits — the title budget must reach a fixed point", () => {
  const titleFor = (i: number, n: number) => (n === 1 ? "Report" : `Report ${i + 1}/${n}`);
  const lines = Array.from({ length: 8 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(4082)}`);
  lines.push("a".repeat(3999), "b".repeat(89));
  const chunks = chunkLines(lines, titleFor, ZOOM_MAX_CHARS);
  for (const c of chunks) {
    const len = messageText({ event: "announcement", title: c.title, detail: c.detail }).length;
    assert.ok(len <= ZOOM_MAX_CHARS, `"${c.title}" renders to ${len} chars — ${len - ZOOM_MAX_CHARS} over, Zoom would reject it`);
  }
  // These lines are deliberately wider than a message, so each is hard-cut with an ellipsis — byte
  // identity is not the property here. Every line must still be PRESENT and in order, which the 3-digit
  // prefix pins without depending on where the cut lands.
  const out = chunks.flatMap((c) => c.detail.split("\n"));
  assert.equal(out.length, lines.length, "no line may be lost while settling the width");
  assert.deepEqual(out.slice(0, 8).map((l) => l.slice(0, 3)), ["000", "001", "002", "003", "004", "005", "006", "007"]);
});

// The same trap one digit up: 9 -> 10 is the cheap case to find, 99 -> 100 the one left behind.
test("the fixed point holds when the counter crosses 99 -> 100", () => {
  const titleFor = (i: number, n: number) => `Part ${i + 1}/${n}`;
  const lines = Array.from({ length: 120 }, () => "z".repeat(4070));
  const chunks = chunkLines(lines, titleFor, ZOOM_MAX_CHARS);
  assert.ok(chunks.length >= 100, `expected the counter to cross into 3 digits, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(messageText({ event: "announcement", title: c.title, detail: c.detail }).length <= ZOOM_MAX_CHARS, `${c.title} over the limit`);
  }
});

test("chunking loses no lines and preserves their order", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  const chunks = chunkLines(lines, (i, n) => `T (${i + 1}/${n})`);
  assert.deepEqual(chunks.flatMap((c) => c.detail.split("\n")), lines, "a dropped client is the one bug this report cannot have");
});

test("the counter in the title matches the real chunk count", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"y".repeat(50)}`);
  const chunks = chunkLines(lines, (i, n) => `Report (${i + 1}/${n})`);
  for (const [i, c] of chunks.entries()) assert.equal(c.title, `Report (${i + 1}/${chunks.length})`);
});

test("a short report stays a single message", () => {
  const chunks = chunkLines(["one", "two"], (i, n) => `T (${i + 1}/${n})`);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].detail, "one\ntwo");
  assert.equal(chunks[0].title, "T (1/1)");
});

// A client name long enough to blow the whole budget would otherwise produce a message the transport
// rejects — taking the rest of that chunk's clients down with it.
test("a single line longer than the whole budget is cut, not emitted whole", () => {
  const monster = "z".repeat(ZOOM_MAX_CHARS * 2);
  const chunks = chunkLines([monster], (i, n) => `T (${i + 1}/${n})`);
  for (const c of chunks) assert.ok(messageText({ event: "announcement", title: c.title, detail: c.detail }).length <= ZOOM_MAX_CHARS);
  assert.match(chunks[0].detail, /…$/, "a truncated line should show that it was truncated");
});

test("chunkLines handles an empty report without producing an empty message", () => {
  assert.deepEqual(chunkLines([], (i, n) => `T (${i + 1}/${n})`), []);
});

test("the report body groups every client under exactly one heading", () => {
  const rows = buildFleetRows(
    [perm({ slug: "a", status: "ok" }), perm({ slug: "c", status: "cred-bad", detail: "GA account" })],
    [{ slug: "a", name: "Alpha", hasCredential: true }, { slug: "c", name: "Charlie", hasCredential: true }, { slug: "n", name: "November", hasCredential: false }]
  );
  const text = reportLines(rows, PP).join("\n");
  assert.match(text, /WORKING CREDENTIAL \(1\)/);
  assert.match(text, /CREDENTIAL WIRED BUT UNUSABLE \(1\)/);
  assert.match(text, /NOT CONFIGURED — no credential wired \(1\)/);
  assert.match(text, /3 clients have Microsoft 365\./);
  for (const name of ["Alpha", "Charlie", "November"]) assert.ok(text.includes(name), `${name} missing from the report`);
});

// ── Grouping + wrapping ─────────────────────────────────────────────────────

test("clients sharing an unusable-credential reason are grouped under it once, not repeated per client", () => {
  const ga = "the username is a UPN (a person), not an application id — this is a Global Admin account";
  const rows = buildFleetRows(
    [
      perm({ slug: "a", status: "cred-bad", detail: ga }),
      perm({ slug: "b", status: "cred-bad", detail: ga }),
      perm({ slug: "c", status: "cred-bad", detail: "Entra rejected this credential (AADSTS7000222)" }),
    ],
    [{ slug: "a", name: "Alpha", hasCredential: true }, { slug: "b", name: "Bravo", hasCredential: true }, { slug: "c", name: "Charlie", hasCredential: true }]
  );
  const text = reportLines(rows, PP).join("\n");
  assert.equal(text.split(ga).length - 1, 1, "the shared reason must be printed once, not once per client");
  assert.match(text, /• .*Global Admin account — 2:/);
  assert.match(text, /Alpha, Bravo/);
  assert.match(text, /AADSTS7000222\) — 1:/);
  // Biggest group first — that's the one worth fixing.
  assert.ok(text.indexOf("Global Admin") < text.indexOf("AADSTS"), "the largest group should lead");
});

test("wrapNames never exceeds the width and never loses a name", () => {
  const names = Array.from({ length: 120 }, (_, i) => `Client Number ${i}`);
  const lines = wrapNames(names, 80);
  for (const l of lines) assert.ok(l.length <= 80 + 1, `line too wide: ${l.length}`); // +1 for the trailing comma
  assert.deepEqual(lines.join(" ").split(", ").map((s) => s.replace(/,$/, "")), names);
});

test("wrapNames keeps a single name that is wider than the width rather than dropping it", () => {
  const long = "x".repeat(200);
  assert.deepEqual(wrapNames([long], 80), [long]);
});

test("wrapNames on an empty list produces no lines", () => {
  assert.deepEqual(wrapNames([], 80), []);
});

// The report's one unforgivable bug: a client silently absent. Checked on a fleet-sized, realistically
// messy input, all the way through chunking to the text that actually goes on the wire.
test("EVERY client survives the whole pipeline — grouping, wrapping and chunking", () => {
  const ga = "the username is a UPN (a person), not an application id — this is a Global Admin account, and the client-credentials flow the runner uses cannot authenticate with it";
  const clients: M365Client[] = [];
  const perms: PermissionRow[] = [];
  for (let i = 0; i < 40; i++) { clients.push({ slug: `w${i}`, name: `Working Client ${i} LLC`, hasCredential: true }); perms.push(perm({ slug: `w${i}`, status: "ok", granted: ["a", "b"], missingOptional: [PP, "Mail.Send"], surplus: [{ role: "Application.ReadWrite.All", escalation: true, why: "w" }] })); }
  for (let i = 0; i < 45; i++) { clients.push({ slug: `b${i}`, name: `Bad Cred Client ${i}, Inc`, hasCredential: true }); perms.push(perm({ slug: `b${i}`, status: "cred-bad", detail: ga })); }
  for (let i = 0; i < 63; i++) clients.push({ slug: `n${i}`, name: `Unconfigured Client ${i}`, hasCredential: false });

  const rows = buildFleetRows(perms, clients);
  assert.equal(rows.length, 148);
  const chunks = chunkLines(reportLines(rows, PP), (i, n) => `M365 permissions (${i + 1}/${n})`);
  const wire = chunks.map((c) => messageText({ event: "announcement", title: c.title, detail: c.detail })).join("\n");
  for (const c of clients) assert.ok(wire.includes(c.name), `${c.name} was lost from the report`);
  for (const c of chunks) assert.ok(messageText({ event: "announcement", title: c.title, detail: c.detail }).length <= ZOOM_MAX_CHARS, "chunk over Zoom's limit");
});

// chunkLines protects headings from being stranded, but only recognises them by shape. This pins the
// two together: a new section whose heading doesn't match fails HERE rather than silently losing its
// no-orphan protection, and a content line that accidentally matches shows up as an extra.
test("report body headings are all recognised as headings, and nothing else is", () => {
  const rows = buildFleetRows(
    [
      perm({ slug: "a", status: "ok" }),
      perm({ slug: "u", status: "unverified" }),
      perm({ slug: "c", status: "cred-bad", detail: "GA account" }),
    ],
    [{ slug: "a", name: "Alpha", hasCredential: true }, { slug: "u", name: "Uniform", hasCredential: true }, { slug: "c", name: "Charlie", hasCredential: true }, { slug: "n", name: "November", hasCredential: false }]
  );
  assert.deepEqual(reportLines(rows, PP).filter(isSectionHeader), [
    "WORKING CREDENTIAL (1)",
    "COULD NOT VERIFY (1)",
    "CREDENTIAL WIRED BUT UNUSABLE (1)",
    "NOT CONFIGURED — no credential wired (1)",
  ]);
});

test("a section heading is never the last line of a message", () => {
  // Sized so a heading would naturally land at a chunk boundary.
  const clients = Array.from({ length: 90 }, (_, i) => ({ slug: `n${i}`, name: `Unconfigured Client Number ${i}`, hasCredential: false }));
  const perms = Array.from({ length: 60 }, (_, i) => perm({ slug: `w${i}`, status: "ok", granted: ["a"], missingOptional: [PP] }));
  clients.push(...perms.map((_, i) => ({ slug: `w${i}`, name: `Working Client Number ${i}`, hasCredential: true })));
  for (const limit of [700, 900, 1200, 1500, 2000, 4096]) {
    const chunks = chunkLines(reportLines(buildFleetRows(perms, clients), PP), (i, n) => `T (${i + 1}/${n})`, limit);
    for (const c of chunks) {
      const last = c.detail.split("\n").filter((l) => l.trim()).pop() ?? "";
      assert.ok(!isSectionHeader(last), `limit ${limit}: chunk "${c.title}" ends on the heading "${last}"`);
    }
  }
});

test("an empty section is omitted rather than printed as a zero heading", () => {
  const rows = buildFleetRows([perm({ slug: "a", status: "ok" })], [{ slug: "a", name: "Alpha", hasCredential: true }]);
  const text = reportLines(rows, PP).join("\n");
  assert.ok(!/NOT CONFIGURED/.test(text));
  assert.ok(!/\(0\)/.test(text));
});
