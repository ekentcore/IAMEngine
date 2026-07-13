import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCoreId, parseCoreIds, importClientByCoreId, sameCompany, type ImportDeps } from "./import-by-coreid";
import type { Action } from "@prisma/client";
import type { SnAccount } from "../servicenow/types";
import type { KbCandidate, KbDiscovery } from "../servicenow/kb-discovery";

const f = (v: string) => ({ value: v, display_value: v });

function account(over: Partial<Record<string, string>> = {}): SnAccount {
  return {
    sys_id: f(over.sysId ?? "a".repeat(32)),
    u_core_id: f(over.coreId ?? "CORE1269"),
    name: f(over.name ?? "Digital Currency Group, Inc."),
    website: f(over.website ?? "www.dcg.co"),
    u_region: f("East"),
    u_time_zone: f("US/Eastern"),
    u_support_status: f("Supported"),
    u_comanaged_it: f("false"),
    u_onboarding: f("1"),
    u_offboarding: f("1"),
    sys_domain: f(over.domain ?? "d".repeat(32)),
  } as unknown as SnAccount;
}

const kb = (number: string, action: "onboard" | "offboard", confident = true): KbCandidate => ({
  number,
  title: `${action} guide`,
  action,
  score: confident ? 11 : 3,
  confident,
  latest: true,
  published: true,
  updatedAt: "2026-01-01 00:00:00",
});

const discovery = (over: Partial<KbDiscovery> = {}): KbDiscovery => ({
  onboard: null,
  offboard: null,
  candidates: [],
  ...over,
});

// A deps set where everything succeeds; each test overrides just the part it exercises.
function deps(over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    isVisible: async () => true,
    findByCoreId: async () => null,
    findBySysId: async () => null,
    findUnclaimedByDomain: async () => null,
    claimForSn: async () => ({ ok: true, claimed: true }),
    hasSystems: async () => false,
    isHandConfigured: async () => false,
    candidateRows: async () => [],
    fetchAccountBySysId: async () => null,
    linkParent: async () => true,
    actionsWithRunbook: async () => [],
    fetchAccount: async () => account(),
    slugExists: async () => false,
    createFromSn: async () => "client-id",
    findKbs: async () => discovery({ onboard: kb("KB0001", "onboard"), offboard: kb("KB0002", "offboard") }),
    fetchKb: async (number) => ({ number, title: `${number} title`, text: "Microsoft 365\n- do the thing" }),
    extract: async () => [{ seq: 0, systemKey: "m365", title: "Microsoft 365", status: "automated", steps: ["do the thing"] }],
    saveRunbook: async () => ({ count: 1, createdSystems: ["m365"] }),
    writeAudit: async () => {},
    ...over,
  };
}

test("normalizeCoreId accepts the shapes an operator actually pastes", () => {
  assert.equal(normalizeCoreId("CORE1269"), "CORE1269");
  assert.equal(normalizeCoreId("core1269"), "CORE1269");
  assert.equal(normalizeCoreId("  core 1269 "), "CORE1269");
  assert.equal(normalizeCoreId("CORE-1269"), "CORE1269");
  assert.equal(normalizeCoreId("1269"), "CORE1269", "a bare number is a CORE id");
  assert.equal(normalizeCoreId("core01269"), "CORE01269", "leading zeros are preserved — the id is a string");
  assert.equal(normalizeCoreId("acme"), null);
  assert.equal(normalizeCoreId("CORE"), null);
  assert.equal(normalizeCoreId(""), null);
});

test("parseCoreIds splits, normalizes, de-duplicates and reports junk", () => {
  const r = parseCoreIds("CORE1269, core832 , 1453\nCORE1269; oops");
  assert.deepEqual(r.ids, ["CORE1269", "CORE832", "CORE1453"], "duplicates collapse, order is kept");
  assert.deepEqual(r.invalid, ["oops"]);

  assert.deepEqual(parseCoreIds("").ids, []);
  assert.deepEqual(parseCoreIds(",,  ,").ids, []);
});

test("parseCoreIds keeps 'CORE 1269' whole instead of tearing it into junk", () => {
  // Splitting on whitespace first would yield a bogus "CORE" token plus a bare "1269".
  assert.deepEqual(parseCoreIds("CORE 1269").ids, ["CORE1269"]);
  assert.deepEqual(parseCoreIds("CORE 1269").invalid, []);
  assert.deepEqual(parseCoreIds("core-832, CORE 1269").ids, ["CORE832", "CORE1269"]);
  // Space-separated ids (no comma) still split.
  assert.deepEqual(parseCoreIds("CORE1269 CORE832").ids, ["CORE1269", "CORE832"]);
});

test("imports a new client and builds both runbooks", async () => {
  const saved: Array<{ slug: string; action: string; kb?: string }> = [];
  const r = await importClientByCoreId(
    deps({
      saveRunbook: async (slug, action, _text, _sections, kbNumber) => {
        saved.push({ slug, action, kb: kbNumber });
        return { count: 3, createdSystems: action === "onboard" ? ["m365", "duo"] : [] };
      },
    }),
    "core1269",
    "ui:test"
  );

  assert.equal(r.status, "imported");
  assert.equal(r.coreId, "CORE1269");
  assert.equal(r.slug, "core1269", "the slug is the CORE id — same rule the roster sync uses");
  assert.equal(r.name, "Digital Currency Group, Inc.");
  assert.deepEqual(
    r.built.map((b) => [b.action, b.kb, b.sections]),
    [["onboard", "KB0001", 3], ["offboard", "KB0002", 3]]
  );
  assert.deepEqual(r.createdSystems, ["m365", "duo"]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(saved, [
    { slug: "core1269", action: "onboard", kb: "KB0001" },
    { slug: "core1269", action: "offboard", kb: "KB0002" },
  ]);
});

test("an existing client's runbook is NEVER rebuilt", async () => {
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "core1269", name: "Digital Currency Group, Inc." }),
      actionsWithRunbook: async () => ["onboard", "offboard"] as Action[],
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 1, createdSystems: [] }; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.equal(r.slug, "core1269");
  assert.deepEqual(saved, [], "an action that already has a runbook must not be touched");
  assert.ok(r.warnings.some((w) => /onboard runbook already exists/.test(w)));
});

test("an existing client's EMPTY action is built (the roster-synced bare row this exists to fix)", async () => {
  // Opening the clients list auto-syncs the roster, so almost every client ALREADY exists as a bare
  // row: no runbook, no systems, cases that plan zero steps. Reporting "exists" and stopping would
  // make the import a no-op for the whole fleet.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "core1269", name: "DCG" }),
      actionsWithRunbook: async () => ["onboard"] as Action[], // offboard is empty
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 5, createdSystems: ["duo"] }; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.deepEqual(saved, ["offboard"], "only the empty action is built");
  assert.deepEqual(r.built.map((b) => b.action), ["offboard"]);
  assert.deepEqual(r.createdSystems, ["duo"]);
});

test("an account already linked by sys_id is 'exists', even without a CORE id on the row", async () => {
  // The roster sync creates clients keyed on sys_id; an older row may carry no coreId. Creating a
  // second client for the same account would be a duplicate the unique sys_id constraint rejects.
  const r = await importClientByCoreId(
    deps({ findByCoreId: async () => null, findBySysId: async () => ({ id: "c1", slug: "acme", name: "Acme" }) }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "exists");
  assert.equal(r.slug, "acme");
});

test("a profile-seeded client (no CORE id, no sys_id) is matched by domain, not duplicated", async () => {
  // prisma/seed.ts writes clients from profiles/*.json with neither key set. Without the domain
  // reconcile the import would create a SECOND row for the same company — and the original, which
  // holds the systems, credentials and case history, would be the one left behind.
  let created = false;
  const claimed: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findUnclaimedByDomain: async (d) => (d === "dcg.co" ? { id: "seeded", slug: "dcg", name: "Digital Currency Group" } : null),
      claimForSn: async (id) => { claimed.push(id); return { ok: true, claimed: true }; },
      createFromSn: async () => { created = true; return "x"; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.equal(r.slug, "dcg", "the seeded client is adopted, not shadowed by a duplicate");
  assert.equal(created, false);
  assert.deepEqual(claimed, ["seeded"], "and it is claimed for the ServiceNow account");
});

test("a CHILD account is never matched by domain — it would adopt its parent's row", async () => {
  // Subsidiaries share their parent's website. The parent is often profile-seeded (no CORE id, no
  // sys_id), so it IS an "unclaimed row with that domain" — and claiming it would stamp the child's
  // identity onto the parent, binding the parent's systems and Delinea secret refs to the child's
  // ServiceNow account. A child gets its own row, full stop.
  let domainLookups = 0;
  let created = false;
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account(), account_parent: f("b".repeat(32)) }) as SnAccount,
      findUnclaimedByDomain: async () => { domainLookups++; return { id: "parent", slug: "acme", name: "Acme Corp" }; },
      createFromSn: async () => { created = true; return "new-child"; },
    }),
    "CORE2181",
    "ui:test"
  );

  assert.equal(r.status, "imported");
  assert.equal(created, true, "the child gets its own row");
  assert.notEqual(r.slug, "acme", "and the parent's row is not adopted");
  assert.equal(domainLookups, 0, "a child account never even asks the domain question");
});

test("a domain match over a client WITH SYSTEMS writes nothing at all", async () => {
  // The domain is a guess. A client with systems has lanes and Delinea secret refs that cases
  // dispatch against — re-keying it to the wrong ServiceNow account would run one client's
  // onboarding against another's tenant. Gate on hasSystems, NOT on isHandConfigured: whether a
  // human or a past import created those systems is irrelevant to how dangerous mis-keying is.
  let claimed = false;
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findUnclaimedByDomain: async () => ({ id: "seeded", slug: "dcg", name: "Digital Currency Group" }),
      hasSystems: async () => true,
      isHandConfigured: async () => false, // seeded rows carry a KB-sourced runbook — must NOT disarm the guard
      claimForSn: async () => { claimed = true; return { ok: true, claimed: true }; },
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 1, createdSystems: [] }; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.equal(claimed, false, "a guessed match must not re-key a client that has systems");
  assert.deepEqual(saved, []);
  assert.ok(r.warnings.some((w) => /link it by hand/i.test(w)));
});

test("a domain match whose NAME disagrees is not adopted — a parent must not claim a subsidiary's row", async () => {
  // The child guard (!parentSysId) only stops a CHILD adopting its parent. Nothing stopped a PARENT
  // account adopting an unclaimed SUBSIDIARY's row — they share a website. Then every case for the
  // parent would run under a client named for the subsidiary.
  let claimed = false;
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => account({ name: "Acme Inc" }),
      findUnclaimedByDomain: async () => ({ id: "sub", slug: "acme-west", name: "Acme West" }),
      claimForSn: async () => { claimed = true; return { ok: true, claimed: true }; },
    }),
    "CORE1000",
    "ui:test"
  );

  assert.equal(r.status, "imported", "the parent gets its own row");
  assert.notEqual(r.slug, "acme-west");
  assert.equal(claimed, false, "the subsidiary's row is not re-keyed");
  assert.ok(r.warnings.some((w) => /name doesn't match/i.test(w)));
});

test("sameCompany is loose about legal suffixes and strict about everything else", () => {
  assert.equal(sameCompany("Acme Corp.", "Acme Corporation"), true);
  assert.equal(sameCompany("Digital Currency Group, Inc.", "Digital Currency Group"), true);
  assert.equal(sameCompany("Acme", "Acme West"), false, "a subsidiary is not its parent");
  assert.equal(sameCompany("Acme", ""), false);
});

test("a child whose parent domain can't be checked is NOT built (fail closed)", async () => {
  // A ServiceNow blip must not end with the parent's runbook saved onto the child — that would give
  // the child systems and permanently sever the inheritance planning relies on.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account(), account_parent: f("b".repeat(32)) }) as SnAccount,
      fetchAccountBySysId: async () => { throw new Error("ServiceNow timed out"); },
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 4, createdSystems: ["m365"] }; },
    }),
    "CORE2181",
    "ui:test"
  );

  assert.equal(r.status, "imported");
  assert.deepEqual(saved, [], "nothing is built when we can't prove the domain is the child's own");
  assert.ok(r.warnings.some((w) => /could not check/i.test(w)));
});

test("a decoy row can't be used to steer the match away from a restricted client", async () => {
  // An operator mints a row carrying a restricted client's CORE id. findByCoreId would return the
  // decoy (which they CAN see), the restricted row it shadows would never be consulted, and the
  // decoy would claim that company's ServiceNow account — pulling its KB and re-routing its cases.
  // So every row that could stand for the account is checked for visibility, not just the match.
  let claimed = false;
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "decoy", slug: "decoy", name: "Decoy" }),
      candidateRows: async () => [
        { id: "decoy", slug: "decoy", name: "Decoy" },
        { id: "restricted", slug: "coretelligent", name: "Coretelligent" },
      ],
      isVisible: async (id) => id !== "restricted",
      claimForSn: async () => { claimed = true; return { ok: true, claimed: true }; },
    }),
    "CORE1",
    "ui:test"
  );

  assert.equal(r.status, "error");
  assert.match(r.error!, /restricted/i);
  assert.equal(claimed, false, "the decoy never claims the restricted client's account");
});

test("a claim lost to a concurrent import is reported, not silently overwritten", async () => {
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "acme", name: "Acme" }),
      claimForSn: async () => ({ ok: false, claimed: false, reason: "this client was linked to a ServiceNow account by someone else just now — re-run the import" }),
    }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "error");
  assert.match(r.error!, /someone else just now/);
});

test("a half-built import can be finished by re-running it", async () => {
  // The first run built the onboard runbook (which created ClientSystem rows) and then the offboard
  // KB fetch failed. Those systems must not make the client look "hand-configured" — otherwise the
  // offboard runbook could NEVER be built by the import, and its offboard cases plan zero steps.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "core1269", name: "DCG" }),
      isHandConfigured: async () => false, // has systems, but they came from a KB import
      actionsWithRunbook: async () => ["onboard"] as Action[],
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 6, createdSystems: [] }; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.deepEqual(saved, ["offboard"], "the run finishes what the last one started");
});

test("a client linked to a DIFFERENT ServiceNow account is refused", async () => {
  // Carrying on would split one account across two rows: linkParent resolves by sys_id and would
  // touch the other row while the runbook landed on this one.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "acme", name: "Acme" }),
      claimForSn: async () => ({ ok: false, claimed: false, reason: "this client is already linked to a different ServiceNow account — check its CORE id" }),
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 1, createdSystems: [] }; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "error");
  assert.match(r.error!, /different ServiceNow account/);
  assert.deepEqual(saved, [], "and nothing is written to either row");
});

test("a child in its PARENT's ServiceNow domain is not given the parent's runbook", async () => {
  // Planning falls back to the parent's systems only while the child has NONE of its own. Building
  // the parent's KB onto the child would give it systems and silently sever that inheritance.
  const saved: string[] = [];
  const sharedDomain = "d".repeat(32);
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account({ domain: sharedDomain }), account_parent: f("b".repeat(32)) }) as SnAccount,
      fetchAccountBySysId: async () => account({ domain: sharedDomain }), // parent, same domain
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 9, createdSystems: ["m365"] }; },
    }),
    "CORE2181",
    "ui:test"
  );

  assert.equal(r.status, "imported");
  assert.deepEqual(saved, [], "the parent's KBs are not saved onto the child");
  assert.deepEqual(r.createdSystems, [], "so the child stays bare and keeps inheriting");
  assert.ok(r.warnings.some((w) => /shares .*domain/i.test(w)));
});

test("a child with its OWN ServiceNow domain still gets built", async () => {
  // CVP practices (Bernville, Coyne) do have their own KBs — a child is not automatically empty.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account({ domain: "d".repeat(32) }), account_parent: f("b".repeat(32)) }) as SnAccount,
      fetchAccountBySysId: async () => account({ domain: "e".repeat(32) }), // parent, DIFFERENT domain
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 4, createdSystems: [] }; },
    }),
    "CORE809",
    "ui:test"
  );

  assert.equal(r.status, "imported");
  assert.deepEqual(saved, ["onboard", "offboard"]);
});

test("a restricted client the operator can't see is refused before any write", async () => {
  let claimed = false;
  const r = await importClientByCoreId(
    deps({
      isVisible: async () => false,
      findByCoreId: async () => ({ id: "restricted", slug: "coretelligent", name: "Coretelligent" }),
      claimForSn: async () => { claimed = true; return { ok: true, claimed: true }; },
    }),
    "CORE1",
    "ui:test"
  );

  assert.equal(r.status, "error");
  assert.match(r.error!, /restricted/i);
  assert.equal(claimed, false);
  assert.equal(r.slug, undefined, "and its slug is not echoed back");
});

test("an unclaimable domain falls through to create rather than hijacking a client's row", async () => {
  // findUnclaimedByDomain returns null for a domain held by a client that ALREADY belongs to an
  // account — the parent-row-hijack case: a subsidiary shares its parent's website, and adopting
  // the parent would re-key it with the child's identity.
  const r = await importClientByCoreId(deps({ findUnclaimedByDomain: async () => null }), "CORE1269", "ui:test");
  assert.equal(r.status, "imported", "a new row for the child, the parent left untouched");
});

test("a client whose sys_id already belongs to another row is an error, not a constraint crash", async () => {
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "acme", name: "Acme" }),
      claimForSn: async () => ({ ok: false, claimed: false, reason: "another client (acme-2) is already linked to this ServiceNow account — merge them by hand" }),
    }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "error");
  assert.match(r.error!, /already linked to this ServiceNow account/);
  assert.equal(r.slug, "acme", "and it still names the client it stumbled on");
});

test("a hand-configured client (already has systems) is never auto-built", async () => {
  // Building would run createMissingSystems and bolt catalog-default lanes onto a curated client —
  // systems it may not own, that the next case would dispatch jobs against.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ id: "c1", slug: "acme", name: "Acme" }),
      isHandConfigured: async () => true,
      actionsWithRunbook: async () => [],
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 1, createdSystems: ["adobe"] }; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.deepEqual(saved, [], "nothing is written to a client that is already configured");
  assert.deepEqual(r.createdSystems, []);
  assert.ok(r.warnings.some((w) => /already has systems/i.test(w)));
});

test("the ServiceNow parent is linked, so an imported child's cases can inherit", async () => {
  const links: Array<[string, string]> = [];
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account({ domain: "d".repeat(32) }), account_parent: f("b".repeat(32)) }) as SnAccount,
      fetchAccountBySysId: async () => account({ domain: "e".repeat(32) }), // parent, different domain
      linkParent: async (child, parent) => { links.push([child, parent]); return true; },
    }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "imported");
  assert.deepEqual(links, [["a".repeat(32), "b".repeat(32)]]);
  assert.deepEqual(r.warnings, []);
});

test("a child whose parent isn't imported yet is told so — not promised inheritance it won't get", async () => {
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account({ domain: "d".repeat(32) }), account_parent: f("b".repeat(32)) }) as SnAccount,
      fetchAccountBySysId: async () => account({ domain: "e".repeat(32) }),
      linkParent: async () => false, // parent not in the DB
    }),
    "CORE1269",
    "ui:test"
  );
  assert.ok(r.warnings.some((w) => /parent account isn't in the system/i.test(w) && /run this import again/i.test(w)));
});

test("an account with no sys_id is an error, not a row upserted onto the empty sys_id", async () => {
  const r = await importClientByCoreId(
    deps({ fetchAccount: async () => ({ ...account(), sys_id: f("") }) as SnAccount }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "error");
  assert.match(r.error!, /sys_id/);
});

test("an id ServiceNow doesn't know is not_found, and nothing is written", async () => {
  let created = false;
  const r = await importClientByCoreId(
    deps({ fetchAccount: async () => null, createFromSn: async () => { created = true; return "x"; } }),
    "CORE9999",
    "ui:test"
  );
  assert.equal(r.status, "not_found");
  assert.equal(created, false);
});

test("junk input is rejected before any I/O", async () => {
  let touched = false;
  const r = await importClientByCoreId(deps({ fetchAccount: async () => { touched = true; return null; } }), "oops", "ui:test");
  assert.equal(r.status, "invalid");
  assert.equal(touched, false);
});

test("a slug collision falls back to a suffixed slug", async () => {
  const r = await importClientByCoreId(deps({ slugExists: async (s) => s === "core1269" }), "CORE1269", "ui:test");
  assert.equal(r.status, "imported");
  assert.match(r.slug!, /^core1269-/);
});

test("no KB in ServiceNow: the client is still created, with a warning", async () => {
  const r = await importClientByCoreId(deps({ findKbs: async () => discovery() }), "CORE1269", "ui:test");
  assert.equal(r.status, "imported");
  assert.equal(r.built.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /no onboard or offboard KB found/i);
});

test("a KB fetch that fails leaves the client created and warns", async () => {
  const r = await importClientByCoreId(
    deps({
      fetchKb: async (number) => {
        if (number === "KB0001") throw new Error("ServiceNow returned 403");
        return { number, title: "t", text: "Microsoft 365\n- x" };
      },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "imported", "a KB failure must not discard the client we just created");
  assert.deepEqual(r.built.map((b) => b.action), ["offboard"], "the other action still builds");
  assert.match(r.warnings[0], /KB0001/);
  assert.match(r.warnings[0], /403/);
});

test("AI extraction failure falls back to the heuristic parse", async () => {
  const sent: Array<unknown> = [];
  const r = await importClientByCoreId(
    deps({
      extract: async () => null, // Azure not configured / call failed
      saveRunbook: async (_s, _a, text, sections) => {
        sent.push({ text, sections });
        return { count: 2, createdSystems: [] };
      },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "imported");
  assert.equal(r.built.length, 2);
  // saveRunbook parses the raw text itself when it gets no preset sections.
  assert.deepEqual((sent[0] as { sections?: unknown }).sections, undefined);
});

test("a low-confidence KB pick is NOT saved — it is named for a human to review", async () => {
  // Century Equity has no onboarding guide, only an "Offboard User Request" form. Saving it would
  // create ClientSystem rows out of whatever the extractor made of that prose — config a live case
  // would then dispatch jobs against.
  const saved: string[] = [];
  const r = await importClientByCoreId(
    deps({
      findKbs: async () => discovery({ offboard: kb("KB0017027", "offboard", false) }),
      saveRunbook: async (_s, a) => { saved.push(a); return { count: 9, createdSystems: ["box"] }; },
    }),
    "CORE82",
    "ui:test"
  );

  assert.equal(r.status, "imported", "the client is still created");
  assert.deepEqual(saved, [], "but nothing is written from a doc that isn't a runbook");
  assert.deepEqual(r.built, []);
  assert.deepEqual(r.createdSystems, [], "and no systems are conjured from it");
  assert.ok(r.warnings.some((w) => w.includes("KB0017027") && /review/i.test(w)));
});

test("a create that fails is reported as an error, not a silent success", async () => {
  const r = await importClientByCoreId(
    deps({ createFromSn: async () => { throw new Error("unique constraint"); } }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "error");
  assert.match(r.error!, /unique constraint/);
  assert.equal(r.slug, undefined, "nothing was created, so there is no client to name");
});

test("a failure AFTER the client is created still names the client it left behind", async () => {
  // Otherwise the row reads "Failed — —" while a real client sits in the list, and the operator has
  // no idea it exists.
  const r = await importClientByCoreId(
    deps({ writeAudit: async () => { throw new Error("db hiccup"); } }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "error");
  assert.equal(r.slug, "core1269");
  assert.equal(r.name, "Digital Currency Group, Inc.");
});

test("a child account with no KB names its parent (cases inherit it at plan time)", async () => {
  const r = await importClientByCoreId(
    deps({
      fetchAccount: async () => ({ ...account({ coreId: "CORE2187", name: "Olympus - LittleRock" }), account_parent: f("Olympus Cosmetic") } as SnAccount),
      findKbs: async () => discovery(),
    }),
    "CORE2187",
    "ui:test"
  );
  assert.equal(r.status, "imported");
  assert.ok(r.warnings.some((w) => w.includes("Olympus Cosmetic")));
});

test("audits the import", async () => {
  const audits: Array<{ action: string; detail?: unknown }> = [];
  await importClientByCoreId(deps({ writeAudit: async (e) => { audits.push(e); } }), "CORE1269", "ui:evan");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "client.create");
  assert.match(JSON.stringify(audits[0].detail), /import/);
});
