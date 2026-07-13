import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCoreId, parseCoreIds, importClientByCoreId, type ImportDeps } from "./import-by-coreid";
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
    findByCoreId: async () => null,
    findBySysId: async () => null,
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

test("a client already in the system is reported, never rebuilt", async () => {
  let built = false;
  const r = await importClientByCoreId(
    deps({
      findByCoreId: async () => ({ slug: "core1269", name: "Digital Currency Group, Inc." }),
      findKbs: async () => { built = true; return discovery(); },
      saveRunbook: async () => { built = true; return null; },
    }),
    "CORE1269",
    "ui:test"
  );

  assert.equal(r.status, "exists");
  assert.equal(r.slug, "core1269");
  assert.equal(built, false, "re-importing must not touch an existing client's runbook");
});

test("an account already linked by sys_id is 'exists', even without a CORE id on the row", async () => {
  // The roster sync creates clients keyed on sys_id; an older row may carry no coreId. Creating a
  // second client for the same account would be a duplicate the unique sys_id constraint rejects.
  const r = await importClientByCoreId(
    deps({ findByCoreId: async () => null, findBySysId: async () => ({ slug: "acme", name: "Acme" }) }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "exists");
  assert.equal(r.slug, "acme");
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
  assert.match(r.warnings[0], /no onboarding or offboarding KB/i);
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

test("a low-confidence KB pick builds but is flagged for review", async () => {
  const r = await importClientByCoreId(
    deps({ findKbs: async () => discovery({ offboard: kb("KB0017027", "offboard", false) }) }),
    "CORE82",
    "ui:test"
  );
  assert.equal(r.status, "imported");
  assert.equal(r.built[0].confident, false);
  assert.ok(r.warnings.some((w) => /review/i.test(w) && w.includes("KB0017027")));
  assert.ok(r.warnings.some((w) => /no onboarding KB/i.test(w)), "the missing action is still called out");
});

test("a create that fails is reported as an error, not a silent success", async () => {
  const r = await importClientByCoreId(
    deps({ createFromSn: async () => { throw new Error("unique constraint"); } }),
    "CORE1269",
    "ui:test"
  );
  assert.equal(r.status, "error");
  assert.match(r.error!, /unique constraint/);
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
