import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreKbCandidates, findClientKbs, type KbCandidate } from "./kb-discovery";

const cfg = { instanceUrl: "https://sn.example.com", username: "u", password: "p" };

// Shape a kb_knowledge row the way sysparm_display_value=all returns it.
function row(number: string, title: string, extra: Partial<{ latest: string; state: string; base: string; updated: string }> = {}) {
  return {
    number: { value: number, display_value: number },
    short_description: { value: title, display_value: title },
    workflow_state: { value: extra.state ?? "published", display_value: extra.state ?? "Published" },
    latest: { value: extra.latest ?? "true" },
    kb_knowledge_base: { value: "x", display_value: extra.base ?? "Co-Managed IT" },
    sys_updated_on: { value: extra.updated ?? "2026-01-01 00:00:00" },
  };
}

const pick = (c: KbCandidate | null) => c?.number ?? null;

test("scores the two common title shapes", () => {
  const r = scoreKbCandidates([
    row("KB0001", "New User Onboarding Guide - Sporos Bioventures, Inc."),
    row("KB0002", "User Offboarding Guide - Sporos Bioventures, Inc."),
  ]);
  assert.equal(pick(r.onboard), "KB0001");
  assert.equal(pick(r.offboard), "KB0002");
});

test("scores the client-name-first title shape", () => {
  const r = scoreKbCandidates([
    row("KB0011547", "Bernville Veterinary Clinic - User Onboarding Guide"),
    row("KB0011549", "Bernville Veterinary Clinic - User Offboarding Guide"),
  ]);
  assert.equal(pick(r.onboard), "KB0011547");
  assert.equal(pick(r.offboard), "KB0011549");
});

test("recognizes 'New Onboard User Guide' (DCG's wording)", () => {
  const r = scoreKbCandidates([row("KB0017968", "New Onboard User Guide - Digital Currency Group")]);
  assert.equal(pick(r.onboard), "KB0017968");
  assert.equal(r.offboard, null);
});

test("a title carrying no client name still resolves by action", () => {
  const r = scoreKbCandidates([row("KB0009", "User Offboarding Guide")]);
  assert.equal(pick(r.offboard), "KB0009");
});

test("rejects uploaded attachments that mention onboarding", () => {
  // Pacific Lake's domain really does hold these; article_type is "text" for them too, so only
  // the filename-ish title distinguishes them from the guide.
  const r = scoreKbCandidates([
    row("KB0031004", "Pacific Lake Partners - Onboarding_Docs.docx"),
    row("KB0031011", "2018-05-29 Pacific Lake Partners - Onboarding_Docs - Initial Review by PLP.pdf"),
    row("KB0036031", "Sporos- Onboarding_Docs_New V3 21-0819.docx"),
  ]);
  assert.equal(r.onboard, null, "an attachment must never be adopted as a runbook");
  assert.equal(r.offboard, null);
});

test("the real guide wins over an attachment in the same domain", () => {
  const r = scoreKbCandidates([
    row("KB0027642", "Long Focus - Onboarding_Doc 20220829.docx"),
    row("KB0027637", "New User Onboarding Guide - Long Focus Capital"),
  ]);
  assert.equal(pick(r.onboard), "KB0027637");
});

test("prefers a guide in the client's own KB base over the shared one", () => {
  const r = scoreKbCandidates([
    row("KB0002", "New User Onboarding Guide - Acme", { base: "Co-Managed IT", updated: "2026-05-01 00:00:00" }),
    row("KB0001", "New User Onboarding Guide - Acme", { base: "Acme", updated: "2020-01-01 00:00:00" }),
  ]);
  assert.equal(pick(r.onboard), "KB0001");
});

test("prefers latest + published, then most recently updated", () => {
  const r = scoreKbCandidates([
    row("KB0001", "New User Onboarding Guide - Acme", { latest: "false", updated: "2026-06-01 00:00:00" }),
    row("KB0002", "New User Onboarding Guide - Acme", { latest: "true", updated: "2024-01-01 00:00:00" }),
  ]);
  assert.equal(pick(r.onboard), "KB0002");

  const r2 = scoreKbCandidates([
    row("KB0003", "New User Onboarding Guide - Acme", { updated: "2024-01-01 00:00:00" }),
    row("KB0004", "New User Onboarding Guide - Acme", { updated: "2026-06-01 00:00:00" }),
  ]);
  assert.equal(pick(r2.onboard), "KB0004");
});

test("a non-guide fallback pick is flagged as not confident", () => {
  // Century Equity really has no onboarding guide — only these. Picking the best of a bad lot is
  // right, but the caller must be able to tell the operator to review it.
  const r = scoreKbCandidates([
    row("KB0017027", "Offboard User Request - Century Equity Partners, LLC"),
    row("KB0017014", "Century User Offboarding"),
  ]);
  assert.equal(r.offboard?.confident, false);
  assert.equal(r.onboard, null);

  const g = scoreKbCandidates([row("KB0001", "User Offboarding Guide - Acme")]);
  assert.equal(g.offboard?.confident, true);
});

test("a title mentioning both actions is claimed by neither", () => {
  const r = scoreKbCandidates([row("KB0005", "Onboarding and Offboarding Guide - Acme")]);
  assert.equal(r.onboard, null);
  assert.equal(r.offboard, null);
});

test("unrelated domain articles are ignored", () => {
  const r = scoreKbCandidates([
    row("KB0043448", "Configure settings for the Webex device to allow local Login"),
    row("KB0017954", "DCG Shutdown and Start-Up Procedures"),
  ]);
  assert.equal(r.onboard, null);
  assert.equal(r.offboard, null);
  assert.equal(r.candidates.length, 0);
});

test("findClientKbs queries by domain and returns the picks", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(url);
    return {
      ok: true,
      json: async () => ({
        result: [row("KB0001", "New User Onboarding Guide - Acme"), row("KB0002", "User Offboarding Guide - Acme")],
      }),
    };
  }) as unknown as typeof fetch;

  const r = await findClientKbs(cfg, "0ebf38201bfb15d00b0811f72a4bcbce", fetcher);
  assert.equal(pick(r.onboard), "KB0001");
  assert.equal(pick(r.offboard), "KB0002");
  assert.match(seen[0], /sys_domain%3D0ebf38201bfb15d00b0811f72a4bcbce/);
  assert.equal(seen.length, 1, "a domain with both guides published needs one round trip");
});

test("findClientKbs falls back to unpublished when nothing is published", async () => {
  const queries: string[] = [];
  const fetcher = (async (url: string) => {
    const q = new URL(url).searchParams.get("sysparm_query") ?? "";
    queries.push(q);
    // First call filters on published and finds nothing; the retry drops that filter.
    const published = q.includes("workflow_state=published");
    return {
      ok: true,
      json: async () => ({
        result: published ? [] : [row("KB0007", "New User Onboarding Guide - Acme", { state: "draft", latest: "false" })],
      }),
    };
  }) as unknown as typeof fetch;

  const r = await findClientKbs(cfg, "a".repeat(32), fetcher);
  assert.equal(pick(r.onboard), "KB0007", "a client whose only guide is unpublished still imports");
  assert.equal(queries.length, 2);
  assert.ok(!queries[1].includes("workflow_state"), "the retry must not filter on state");
});

test("findClientKbs returns nothing for a client with no domain", async () => {
  const fetcher = (async () => {
    throw new Error("must not call ServiceNow without a domain");
  }) as unknown as typeof fetch;
  const r = await findClientKbs(cfg, "", fetcher);
  assert.equal(r.onboard, null);
  assert.equal(r.offboard, null);
});

test("findClientKbs rejects a domain sys_id that isn't a sys_id", async () => {
  // Defense in depth: the value is interpolated into sysparm_query, where `^` is an operator.
  const fetcher = (async () => {
    throw new Error("must not call ServiceNow with an injected query");
  }) as unknown as typeof fetch;
  const r = await findClientKbs(cfg, "abc^ORsys_idISNOTEMPTY", fetcher);
  assert.equal(r.onboard, null);
  assert.equal(r.candidates.length, 0);
});
