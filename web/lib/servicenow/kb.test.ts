import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchKbArticle } from "./kb";

const cfg = { instanceUrl: "https://x.example.com", username: "u", password: "p" } as never;
const row = (text: string, opts: { latest?: string; state?: string }) => ({
  number: { display_value: "KB0017271" },
  short_description: { display_value: "Onboarding" },
  text: { value: text },
  workflow_state: { value: opts.state ?? "outdated" },
  latest: { value: opts.latest ?? "false" },
  sys_updated_on: { value: "x" },
});
const fetcherReturning = (rows: unknown[]): typeof fetch =>
  (async () => new Response(JSON.stringify({ result: rows }), { status: 200, headers: { "content-type": "application/json" } })) as never;

test("fetchKbArticle picks the latest=true revision, not an arbitrary older one", async () => {
  // A KB updated many times = many rows under the same number. Must pick the live one.
  const rows = [
    row("<p>Microsoft 365 E3 (no Teams)</p>", { latest: "false", state: "outdated" }),
    row("<p>Microsoft 365 Business Premium</p>", { latest: "true", state: "published" }),
    row("<p>even older</p>", { latest: "false", state: "outdated" }),
  ];
  const art = await fetchKbArticle(cfg, "KB0017271", fetcherReturning(rows));
  assert.match(art!.text, /Business Premium/);
  assert.doesNotMatch(art!.text, /E3 \(no Teams\)/);
});

test("fetchKbArticle falls back to published when no latest flag, else the first (newest) row", async () => {
  const published = await fetchKbArticle(cfg, "KB0017271", fetcherReturning([
    row("<p>old</p>", { state: "outdated" }),
    row("<p>current</p>", { state: "published" }),
  ]));
  assert.match(published!.text, /current/);

  // No latest, none published -> first row (the query orders newest-first by sys_updated_on).
  const newest = await fetchKbArticle(cfg, "KB0017271", fetcherReturning([
    row("<p>newest</p>", {}),
    row("<p>older</p>", {}),
  ]));
  assert.match(newest!.text, /newest/);
});

test("fetchKbArticle returns null when no rows", async () => {
  assert.equal(await fetchKbArticle(cfg, "KB0017271", fetcherReturning([])), null);
});
