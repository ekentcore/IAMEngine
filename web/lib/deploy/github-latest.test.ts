import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubStatus } from "./github-latest";

// A scripted fetch: maps URL substrings to {status, body}. Records call count per URL.
function fakeFetch(routes: Array<{ match: string; status?: number; body?: unknown; throw?: boolean }>) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes.find((x) => url.includes(x.match));
    if (!r || r.throw) throw new Error("network down");
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const headBody = (sha: string) => ({ sha, commit: { committer: { date: "2026-07-24T13:40:00Z" }, message: "Latest thing\n\nbody" } });

test("returns the latest commit and no compare call when the running build IS the tip", async () => {
  const { fn, calls } = fakeFetch([{ match: "/commits/", body: headBody("tipSHA") }]);
  const gh = createGitHubStatus({ fetch: fn, now: () => 1000 }, "owner/repo", "main");
  const r = await gh.latest("tipSHA");
  assert.equal(r.latest?.sha, "tipSHA");
  assert.equal(r.latest?.shortSha, "tipSHA".slice(0, 7));
  assert.equal(r.latest?.message, "Latest thing"); // first line only
  assert.equal(r.behindBy, 0);
  assert.equal(r.error, null);
  assert.equal(calls.filter((c) => c.includes("/compare/")).length, 0);
});

test("calls compare and reports behind_by when the running build differs", async () => {
  const { fn, calls } = fakeFetch([
    { match: "/commits/", body: headBody("newSHA") },
    { match: "/compare/", body: { behind_by: 3 } },
  ]);
  const gh = createGitHubStatus({ fetch: fn, now: () => 1000 }, "owner/repo", "main");
  const r = await gh.latest("oldSHA");
  assert.equal(r.behindBy, 3);
  assert.equal(calls.filter((c) => c.includes("/compare/")).length, 1);
});

test("caches within the TTL — a second call does not hit the network", async () => {
  const { fn, calls } = fakeFetch([{ match: "/commits/", body: headBody("tipSHA") }]);
  let t = 1000;
  const gh = createGitHubStatus({ fetch: fn, now: () => t }, "owner/repo", "main");
  await gh.latest("tipSHA");
  t += 60_000; // still < 5 min TTL
  await gh.latest("tipSHA");
  assert.equal(calls.length, 1);
});

test("re-fetches after the TTL expires", async () => {
  const { fn, calls } = fakeFetch([{ match: "/commits/", body: headBody("tipSHA") }]);
  let t = 1000;
  const gh = createGitHubStatus({ fetch: fn, now: () => t }, "owner/repo", "main");
  await gh.latest("tipSHA");
  t += 6 * 60_000; // past the 5 min TTL
  await gh.latest("tipSHA");
  assert.equal(calls.length, 2);
});

test("never throws on a network error — returns an error result", async () => {
  const { fn } = fakeFetch([{ match: "/commits/", throw: true }]);
  const gh = createGitHubStatus({ fetch: fn, now: () => 1000 }, "owner/repo", "main");
  const r = await gh.latest("anySHA");
  assert.equal(r.latest, null);
  assert.equal(r.behindBy, null);
  assert.ok(r.error);
});

test("a compare failure degrades to unknown distance, keeping the latest commit", async () => {
  const { fn } = fakeFetch([
    { match: "/commits/", body: headBody("newSHA") },
    { match: "/compare/", throw: true },
  ]);
  const gh = createGitHubStatus({ fetch: fn, now: () => 1000 }, "owner/repo", "main");
  const r = await gh.latest("oldSHA");
  assert.equal(r.latest?.sha, "newSHA");
  assert.equal(r.behindBy, null);
  assert.equal(r.error, null);
});
